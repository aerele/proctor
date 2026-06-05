#!/usr/bin/env python3
"""acquire — data acquisition layer for the live poller.

Two backends behind one interface (Acquirer):

  FixturesAcquirer  — reads a committed contest-eval run dir
                      (data/raw/contest_<id>_meta.json + code_<id>.json).
                      Fully standalone; no network, no browser. Used for
                      validation and for any offline replay.

  LiveAcquirer      — acquires from HackerRank's REST API via the authenticated
                      Chromium on :9222, UNATTENDED. It drives Chrome directly
                      through monitoring/cdp.py (a dependency-light CDP client):
                      each call opens its OWN background tab on hackerrank.com,
                      runs the same-origin credentialed fetch() JS, returns the
                      parsed JSON, and closes ONLY its own tab. No agent and no
                      chrome-devtools MCP are involved — the poller loops on its
                      own. If :9222 is unreachable (or the page never reaches the
                      HR origin), the CDP layer raises and LiveAcquirer converts it
                      to LiveUnavailable so the poller falls back to fixtures.

                      A legacy file-drop bridge (write request JS -> agent runs it
                      -> read result JSON) is still available via use_cdp=False for
                      environments without a debuggable Chrome.

The fetch JS this module emits is the canonical, rate-limit-safe recipe from
contest-eval/METHOD-handoff.md:
  - metadata (leaderboard + judge_submissions) is unthrottled -> fetch all at once
  - code endpoint is 429-throttled -> hardest-accepted-first, ~1-1.5s between
    fetches, ~8s between batches, detect 429 explicitly, NEVER store a failed fetch.

Field RENAMES are applied here (acquisition owns the contract), so the meta dict
the analysis sees is already: leaderboard[].user/rank/score/time_taken/school,
challenges[].slug/name/solved/total/max_score, submissions[].id/user/ch/chName/
lang/status/score/tfs/created.
"""
import json
from pathlib import Path


# ---------------------------------------------------------------------------
# Fixtures backend
# ---------------------------------------------------------------------------
class FixturesAcquirer:
    def __init__(self, fixtures_dir, contest_id=None):
        self.dir = Path(fixtures_dir)
        self.contest_id = contest_id
        self._meta = None
        self._code = None

    def _find(self, pattern_glob):
        # accept either <dir>/data/raw/<file> or <dir>/<file>
        for base in (self.dir / "data" / "raw", self.dir):
            hits = sorted(base.glob(pattern_glob))
            if hits:
                return hits[0]
        return None

    def fetch_metadata(self):
        """Return the meta dict {slug, leaderboard, challenges, submissions}."""
        if self._meta is None:
            if self.contest_id:
                f = self._find(f"contest_{self.contest_id}_meta.json")
            else:
                f = self._find("contest_*_meta.json")
            if not f:
                raise FileNotFoundError(f"no meta json under {self.dir}")
            self._meta = json.loads(f.read_text())
        return self._meta

    def fetch_code(self, submission_ids=None):
        """Return {id(str): code(str)} for the requested ids (or all if None)."""
        if self._code is None:
            if self.contest_id:
                f = self._find(f"code_{self.contest_id}.json")
            else:
                f = self._find("code_*.json")
            if not f:
                raise FileNotFoundError(f"no code json under {self.dir}")
            self._code = json.loads(f.read_text())
        if submission_ids is None:
            return dict(self._code)
        want = set(str(x) for x in submission_ids)
        return {k: v for k, v in self._code.items() if k in want}

    @property
    def mode(self):
        return "fixtures"


# ---------------------------------------------------------------------------
# Live backend (chrome-devtools MCP bridge)
# ---------------------------------------------------------------------------
class LiveAcquirer:
    """Unattended acquisition from the authenticated browser via cdp.py.

    Each fetch opens its OWN background hackerrank.com tab, runs the same-origin
    credentialed fetch() JS, returns parsed JSON, and closes ONLY its own tab —
    the poller never needs an agent. CDP/browser failures (port down, no HR
    origin, JS exception) become LiveUnavailable so the poller falls back to
    fixtures or skips the cycle.

    The same JS payloads (metadata + 429-safe hardest-first code fetch) are
    preserved. A legacy file-drop bridge is kept for environments without a
    debuggable Chrome (use_cdp=False): the poller writes request JS under
    <drop_dir>/requests/ and reads results from <drop_dir>/results/.
    """

    # A real same-origin page so credentialed fetch() carries HR session cookies.
    HR_ORIGIN_URL = "https://www.hackerrank.com/dashboard"

    def __init__(self, slug, drop_dir, contest_id=None, use_cdp=True,
                 devtools_url=None):
        self.slug = slug
        self.contest_id = contest_id
        self.drop = Path(drop_dir)
        self.use_cdp = use_cdp
        self.devtools_url = devtools_url
        (self.drop / "requests").mkdir(parents=True, exist_ok=True)
        (self.drop / "results").mkdir(parents=True, exist_ok=True)

    @property
    def mode(self):
        return "live"

    # ----- unattended CDP path -----
    def _cdp_run(self, expression, eval_timeout):
        """Run a fetch JS expression via cdp.run_fetch; map all CDP failures to
        LiveUnavailable. Imported lazily so fixtures-only use never imports cdp."""
        import cdp
        kwargs = {"url": self.HR_ORIGIN_URL, "eval_timeout": eval_timeout}
        if self.devtools_url:
            kwargs["devtools_url"] = self.devtools_url
        try:
            return cdp.run_fetch(expression, **kwargs)
        except cdp.CDPError as e:
            raise LiveUnavailable(f"CDP fetch failed: {e}") from e

    def fetch_metadata(self):
        if self.use_cdp:
            res = self._cdp_run(self.metadata_js(), eval_timeout=120.0)
            if not isinstance(res, dict) or "leaderboard" not in res:
                raise LiveUnavailable(f"metadata fetch returned unexpected shape: "
                                      f"{type(res).__name__}")
            # persist a copy of the raw result for the file-drop consumers / debug
            self._write_result("meta", res)
            return res
        # ----- legacy file-drop bridge -----
        res = self._read_result("meta")
        if res is None:
            self._write_request("meta", {"js": self.metadata_js()})
            raise LiveUnavailable(
                "metadata result not present; run the emitted metadata JS via "
                "evaluate_script and write the renamed meta dict to "
                f"{self.drop/'results'/'meta.json'}")
        return res

    def fetch_code(self, submission_ids):
        want = set(str(x) for x in submission_ids)
        if self.use_cdp:
            res = self._cdp_run(self.code_fetch_js(submission_ids), eval_timeout=120.0)
            # the code JS returns {_meta:{...}, code:{id:code}}
            code = res.get("code", res) if isinstance(res, dict) else {}
            self._write_result("code", res if isinstance(res, dict) else {})
            return {k: v for k, v in code.items()
                    if k in want and isinstance(v, str) and len(v) >= 15}
        # ----- legacy file-drop bridge -----
        res = self._read_result("code")
        self._write_request("code", {
            "js": self.code_fetch_js(submission_ids),
            "ids": [str(x) for x in submission_ids],
        })
        if res is None:
            raise LiveUnavailable(
                "code result not present; run the emitted hardest-first throttled "
                "code-fetch JS and write {id:code} to "
                f"{self.drop/'results'/'code.json'}")
        # the file-drop result may be {id:code} or {code:{id:code}}
        code = res.get("code", res) if isinstance(res, dict) else {}
        return {k: v for k, v in code.items()
                if k in want and isinstance(v, str) and len(v) >= 15}

    # ----- result/request plumbing (also used by the legacy bridge) -----
    def _read_result(self, name):
        f = self.drop / "results" / f"{name}.json"
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    def _write_result(self, name, payload):
        try:
            f = self.drop / "results" / f"{name}.json"
            f.write_text(json.dumps(payload, indent=1))
        except OSError:
            pass

    def _write_request(self, name, payload):
        f = self.drop / "requests" / f"{name}.json"
        f.write_text(json.dumps(payload, indent=1))

    # ----- the same-origin fetch JS (run in our OWN tab, NON-DISRUPTIVE) -----
    def metadata_js(self):
        """Same-origin fetch of leaderboard + challenges + judge_submissions.
        Returns the RENAMED meta dict directly. Run from a hackerrank.com tab."""
        return _METADATA_JS.replace("__SLUG__", self.slug)

    def code_fetch_js(self, submission_ids):
        """Hardest-accepted-first throttled code fetch for the given ids.
        429-safe: detects 429, never stores a failed fetch, ~1.2s between fetches,
        accumulates on window.__code + localStorage so a tool-timeout is safe."""
        ids = json.dumps([str(x) for x in submission_ids])
        return _CODE_JS.replace("__SLUG__", self.slug).replace("__IDS__", ids)


class LiveUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# JS payloads (run via mcp__chrome-devtools__evaluate_script in a HR tab)
# ---------------------------------------------------------------------------
# Metadata: unthrottled. Pages leaderboard + judge_submissions, maps difficulty
# from solved_count, applies the field renames the analysis layer expects.
_METADATA_JS = r"""
async () => {
  const SLUG = "__SLUG__";
  const J = u => fetch(u, {headers:{'Accept':'application/json'}, credentials:'include'}).then(r=>r.json());
  // challenges
  const ch = [];
  for (let off=0; ; off+=100) {
    const d = await J(`/rest/contests/${SLUG}/challenges?offset=${off}&limit=100`);
    const m = (d && d.models) || [];
    for (const c of m) ch.push({
      slug: c.slug, name: c.name,
      difficulty: c.difficulty_name, max_score: c.max_score,
      solved: c.solved_count, total: c.total_count,
      success_ratio: c.success_ratio, skill_slug: c.skill_slug
    });
    if (!m.length || m.length < 100) break;
  }
  // leaderboard
  const lb = [];
  for (let off=0; ; off+=100) {
    const d = await J(`/rest/contests/${SLUG}/leaderboard?offset=${off}&limit=100`);
    const m = (d && d.models) || [];
    for (const r of m) lb.push({
      rank: r.rank, user: r.hacker, score: r.score,
      time_taken: r.time_taken, lang: null, school: r.school || null
    });
    if (!m.length || m.length < 100) break;
  }
  // submissions metadata
  const subs = [];
  for (let off=0; ; off+=100) {
    const d = await J(`/rest/contests/${SLUG}/judge_submissions/?offset=${off}&limit=100`);
    const m = (d && d.models) || [];
    for (const s of m) subs.push({
      id: s.id, user: s.hacker_username,
      ch: s.challenge && s.challenge.slug, chName: s.challenge && s.challenge.name,
      lang: s.language, status: s.status, score: s.score,
      tfs: s.time_from_start, created: s.created_at
    });
    if (!m.length || m.length < 100) break;
  }
  return { slug: SLUG, fetched_total: subs.length, leaderboard: lb, challenges: ch, submissions: subs };
}
""".strip()

# Code fetch: 429-throttled. Builds id->challengeSlug from a fresh metadata pull,
# orders the requested ids hardest-accepted-first, then loops with the safe recipe.
# Accumulates on window.__code + localStorage; returns {id:code} for what succeeded.
_CODE_JS = r"""
async () => {
  const SLUG = "__SLUG__";
  const WANT = __IDS__;
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const J = u => fetch(u, {headers:{'Accept':'application/json'}, credentials:'include'});
  // (re)build id -> challengeSlug + difficulty from judge_submissions + challenges
  const chDiff = {};
  for (let off=0; ; off+=100) {
    const d = await (await J(`/rest/contests/${SLUG}/challenges?offset=${off}&limit=100`)).json();
    const m = (d && d.models) || [];
    for (const c of m) chDiff[c.slug] = (c.solved_count==null?999:c.solved_count);
    if (!m.length || m.length < 100) break;
  }
  const slugById = {}, hardById = {};
  for (let off=0; ; off+=100) {
    const d = await (await J(`/rest/contests/${SLUG}/judge_submissions/?offset=${off}&limit=100`)).json();
    const m = (d && d.models) || [];
    for (const s of m) { slugById[s.id] = s.challenge && s.challenge.slug; hardById[s.id] = chDiff[s.challenge && s.challenge.slug]; }
    if (!m.length || m.length < 100) break;
  }
  // restore any prior progress (survives navigation)
  let store = {};
  try { store = JSON.parse(localStorage.getItem('__poller_code__')||'{}'); } catch(e){}
  window.__code = window.__code || store;
  // hardest-accepted-first: ascending solved_count
  const todo = WANT.filter(id => !window.__code[id]).sort((a,b)=>(hardById[a]??999)-(hardById[b]??999));
  let done=0, rl=0;
  const t0 = Date.now();
  for (const id of todo) {
    if (Date.now()-t0 > 40000) break;            // tool-timeout guard
    const slug = slugById[id]; if (!slug) continue;
    const r = await J(`/rest/contests/${SLUG}/challenges/${slug}/submissions/${id}`);
    if (r.status === 429) { rl++; await sleep(8000); continue; }   // NEVER store a 429
    let d; try { d = await r.json(); } catch(e) { continue; }
    const c = d && d.model && d.model.code;
    if (typeof c === 'string' && c.length >= 15) { window.__code[id] = c; done++; }
    await sleep(1200);
  }
  localStorage.setItem('__poller_code__', JSON.stringify(window.__code));
  const remaining = WANT.filter(id => !window.__code[id]).length;
  return { _meta:{done, rl, remaining, returned:Object.keys(window.__code).length},
           code: window.__code };
}
""".strip()


def make_acquirer(args):
    """Factory: pick the backend from parsed CLI args.

    --fixtures wins (offline). Otherwise live: by default UNATTENDED via cdp.py
    against :9222; --live-bridge switches to the legacy file-drop bridge.
    """
    if args.fixtures:
        return FixturesAcquirer(args.fixtures, contest_id=args.contest_id)
    drop = Path(args.data_dir) / "live"
    use_cdp = not getattr(args, "live_bridge", False)
    return LiveAcquirer(
        args.slug, drop, contest_id=args.contest_id, use_cdp=use_cdp,
        devtools_url=getattr(args, "devtools_url", None))

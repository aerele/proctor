// backend/src/evalUiClient.js — the /eval-ui browser app (served by eval-server
// at GET /eval-ui/app.js; NOT a node module — never imported server-side, only
// served as a static asset). Imports the SAME pure recommendation module the
// node tests pin, served at /eval-ui/recommend.js.
//
// Self-authenticates (no token comes from the parent iframe): asks for the admin
// password once, keeps it in this origin's localStorage, replays it as
// x-admin-password on the same-origin data fetch. All candidate names render via
// textContent (never innerHTML) — PII cannot inject markup.
import {
  computeRecommendationReport,
  isHireBucket,
  BUCKET,
} from "/eval-ui/recommend.js";

const PW_KEY = "proctorEvalAdminPw";
const root = document.getElementById("root");
const params = new URLSearchParams(location.search);
const CONTEST = (params.get("contest") || "").trim();

let lastReport = null;

// --- tiny DOM helper (textContent-safe) ---
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
function clear() { root.replaceChildren(); }

// --- integrity tier → human label / css class ---
const TIER_LABEL = {
  clean: "clean", watch: "desk-check", inconclusive: "limited data",
  flag: "review", confirmed: "confirmed copying",
};
function tierLabel(t) { return TIER_LABEL[t] || t || "—"; }

// ============================ STATES ============================
function showState(node) { clear(); root.append(el("div", { class: "state" }, node)); }

function showGate(errMsg) {
  clear();
  const input = el("input", { type: "password", placeholder: "Admin password", autofocus: "true" });
  const err = el("p", { class: "err", text: errMsg || "" });
  const submit = () => {
    const pw = input.value.trim();
    if (!pw) { err.textContent = "Enter the admin password."; return; }
    localStorage.setItem(PW_KEY, pw);
    load();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  const gate = el("div", { class: "gate" },
    el("h2", { text: "Evaluation" }),
    el("p", { text: "Enter the admin password to view candidate recommendations." }),
    err, input,
    el("button", { onClick: submit, text: "View recommendations" }),
  );
  root.append(el("div", { class: "overlay" }, gate));
  setTimeout(() => input.focus(), 30);
}

// ============================ DATA ============================
async function load() {
  if (!CONTEST) { showState(el("span", { text: "No contest selected. Choose a contest to see its evaluation." })); return; }
  const pw = localStorage.getItem(PW_KEY);
  if (!pw) { showGate(); return; }
  showState(el("span", null, el("span", { class: "spin" }), "Loading evaluation…"));
  let res;
  try {
    res = await fetch("/api/admin/contest-evaluations?contest=" + encodeURIComponent(CONTEST), {
      headers: { "x-admin-password": pw },
    });
  } catch (e) {
    showState(el("span", { text: "Network error contacting the evaluation service. Try refreshing." }));
    return;
  }
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(PW_KEY);
    showGate("That password was rejected. Try again.");
    return;
  }
  if (!res.ok) { showState(el("span", { text: "Evaluation service error (" + res.status + ")." })); return; }
  let data;
  try { data = await res.json(); } catch (e) { showState(el("span", { text: "Malformed response from the evaluation service." })); return; }
  const report = computeRecommendationReport(data.evaluations || [], data.meta || {});
  lastReport = report;
  render(report);
}

function signOut() { localStorage.removeItem(PW_KEY); showGate(); }

// ============================ RENDER ============================
function pct(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))); }

function toneOf(bucket) {
  if (bucket === BUCKET.STRONG_HIRE) return "good";
  if (bucket === BUCKET.HIRE_DESKCHECK || bucket === BUCKET.HOLD_REVIEW) return "warn";
  if (bucket === BUCKET.EXCLUDE_INTEGRITY) return "bad";
  return "muted";
}

function badge(tier) {
  return el("span", { class: "badge " + (tier || ""), text: tierLabel(tier) });
}

// shadow-leaderboard movement chip: where this candidate sat on the RAW
// leaderboard vs where the integrity-adjusted ranking puts them.
function deltaChip(c) {
  if (c.raw_rank == null) return null;
  const d = c.rank_delta || 0;
  if (d > 0) return el("span", { class: "deltachip up", title: "raw leaderboard #" + c.raw_rank, text: "▲" + d + " · raw #" + c.raw_rank });
  if (d < 0) return el("span", { class: "deltachip down", title: "raw leaderboard #" + c.raw_rank, text: "▼" + Math.abs(d) + " · raw #" + c.raw_rank });
  return el("span", { class: "deltachip flat", text: "raw #" + c.raw_rank });
}

function candidateRow(c, opts) {
  opts = opts || {};
  const tone = toneOf(c.bucket);
  const confNote = (c.confidence && c.confidence !== "high")
    ? "Lower-confidence assessment" + (c.missing_signals && c.missing_signals.length ? " — thin/absent: " + c.missing_signals.join(", ") : " (" + c.confidence + " coverage)")
    : null;
  const summary = el("summary", null,
    el("div", { class: "rank", text: opts.rankField ? "#" + c[opts.rankField] : "" }),
    el("div", { class: "who" },
      el("div", null,
        el("span", { class: "name", text: c.name }),
        c.candidate_id ? el("span", { class: "id", text: c.candidate_id }) : null,
      ),
      el("div", { class: "reason", text: c.reason }),
      confNote ? el("div", { class: "conf-note", text: confNote }) : null,
    ),
    el("div", { class: "right" },
      deltaChip(c),
      badge(c.integrity_tier),
      el("div", { class: "scorewrap" },
        el("div", { class: "scoreline" }, el("b", { text: String(c.composite) }), " talent", c.talent_tier ? " · " + c.talent_tier : ""),
        el("div", { class: "bar" }, el("i", { style: "width:" + pct(c.composite) + "%" })),
        el("div", { class: "scoreline", text: "raw " + c.total_score + (c.max_total ? "/" + c.max_total : "") }),
      ),
    ),
  );

  // dossier = the recommendation as an ARGUMENT: FOR (talent) vs AGAINST (integrity).
  const kase = c.case || { for: [], against: [] };
  const forCard = el("div", { class: "casecard forc" }, el("h4", { text: "The case for" }));
  (kase.for || []).forEach((s) => forCard.append(el("div", { class: "for-item" }, el("span", { class: "tick", text: "✓" }), el("span", { text: s }))));
  if (c.one_line) forCard.append(el("div", { class: "one-line", text: c.one_line }));

  const againstCard = el("div", { class: "casecard against" }, el("h4", { text: "The case against" }));
  // twin-pairs: the conclusive copying relationship(s) — who / how many problems /
  // submit-gap on the hard problem / same room. The verifiable receipt.
  if (c.peer_evidence && c.peer_evidence.length) {
    for (const pe of c.peer_evidence) {
      const bits = [pe.n_problems + " shared problem" + (pe.n_problems === 1 ? "" : "s")];
      if (pe.n_hard) bits.push(pe.n_hard + " hard");
      if (pe.same_room && pe.room) bits.push("same room (" + pe.room + ")");
      if (pe.hard_delta) bits.push("hard " + pe.hard_delta.problem + ": " + (pe.hard_delta.i_was_first ? "submitted first" : pe.peer_name + " submitted first") + ", " + pe.hard_delta.dt_sec + "s apart");
      againstCard.append(el("div", { class: "twin" },
        el("div", { class: "twin-head" },
          el("span", { text: "Identical code shared with " }),
          el("b", { text: pe.peer_name }),
          pe.peer ? el("span", { class: "twin-id", text: pe.peer }) : null,
        ),
        el("div", { class: "twin-meta", text: bits.join(" · ") }),
      ));
    }
  }
  if (c.flags && c.flags.length) {
    for (const f of c.flags) {
      againstCard.append(el("div", { class: "flag" },
        el("span", { class: "sev " + (f.severity || "info"), text: f.severity || "info" }),
        el("div", { class: "ftext" },
          el("div", null,
            el("span", { class: "fl-label", text: f.label }),
            f.weak ? el("span", { class: "fl-weak", text: "· weak signal" }) : null,
          ),
          f.evidence ? el("div", { class: "fl-ev", text: f.evidence }) : null,
          f.problem_id ? el("div", { class: "fl-pid", text: "problem: " + f.problem_id }) : null,
        ),
      ));
    }
    if (c.bucket === BUCKET.HIRE_DESKCHECK) {
      againstCard.append(el("div", { class: "reassure", text: "Why this is a desk-check and not a block: a single weak signal like this is not, on its own, evidence of copying — confirm it in a short desk-check before an offer." }));
    }
  } else if (!(c.peer_evidence && c.peer_evidence.length)) {
    // honest absence: only claim a conclusive clean record on full high-confidence
    // coverage; with thin/absent capture, say "clean on what was recorded".
    const thin = (c.confidence && c.confidence !== "high") || (c.missing_signals && c.missing_signals.length);
    const txt = thin
      ? "No adverse signal in the captured streams, but coverage was limited" +
        (c.missing_signals && c.missing_signals.length ? " (thin/absent: " + c.missing_signals.join(", ") + ")" : "") +
        " — clean on what was recorded, not a full clearance."
      : "No adverse signal on any captured stream — clean editor history.";
    againstCard.append(el("div", { class: "nodossier", text: txt }));
  }

  const dossier = el("div", { class: "dossier" }, el("div", { class: "case2" }, forCard, againstCard));
  return el("details", { class: "row " + tone }, summary, dossier);
}

function section(title, count, note, body) {
  const head = el("div", { class: "sec-head" }, el("h2", { text: title }), count != null ? el("span", { class: "count", text: count }) : null);
  const sec = el("section", null, head);
  if (note) sec.append(el("p", { class: "sec-note", text: note }));
  sec.append(body);
  return sec;
}

function group(title, count, body, open) {
  const d = el("details", { class: "group" });
  if (open) d.setAttribute("open", "true");
  d.append(el("summary", null, el("span", { class: "caret", text: "▶" }), title, el("span", { class: "count", text: "(" + count + ")" })));
  d.append(body);
  return d;
}

function render(report) {
  clear();
  const c = report.counts;

  // header
  const header = el("div", { class: "head" },
    el("div", null,
      el("h1", { text: "Evaluation — " + (report.contest_slug || CONTEST) }),
      el("div", { class: "served", text: "Rendered by the proctor-eval service · integrity-adjusted talent ranking" }),
    ),
    el("div", { class: "topbtns" },
      el("button", { class: "linkbtn", onClick: load, text: "Refresh" }),
      el("button", { class: "linkbtn", onClick: signOut, text: "Sign out" }),
    ),
  );
  root.append(header);
  root.append(el("p", { class: "sub", text: c.participants + " candidates evaluated" + (c.phantoms ? " · " + c.phantoms + " enrolled identities had no captured session data (not ranked)" : "") }));

  // methodology note — a PRIOR one-time validation of the ruleset against a
  // labeled control set, NOT this contest's results. Framed + styled as
  // methodology (not a green result banner) so the bold numbers above the fold
  // are only THIS contest's counts (chips, below).
  const cal = report.calibration;
  if (cal) {
    root.append(el("div", { class: "calib" },
      el("span", { class: "ck", text: "Methodology:" }),
      el("span", null,
        "this ruleset was calibrated once against a labeled control set (" + cal.control_cohort +
        "), where every org-selected hire was retained and every confirmed copier excluded. " + cal.note),
    ));
  }

  // chips
  const chips = el("div", { class: "chips" },
    el("span", { class: "chip good" }, el("b", { text: String(c.strong_hire) }), " strong hire"),
    el("span", { class: "chip warn" }, el("b", { text: String(c.hire_deskcheck) }), " hire · desk-check"),
    c.hold_review ? el("span", { class: "chip warn" }, el("b", { text: String(c.hold_review) }), " hold · review") : null,
    el("span", { class: "chip bad" }, el("b", { text: String(c.exclude_integrity) }), " excluded · integrity"),
    el("span", { class: "chip" }, el("b", { text: String(c.below_bar) }), " below bar"),
  );
  root.append(chips);

  // headline insight — split the "trap" count by WHY (don't brand a below-bar
  // genuine candidate or an unconfirmed hold as "integrity-failed").
  const nTrap = report.rawScoreTraps.length;
  const nMiss = report.missedByRawScore.length;
  const nCopy = report.rawScoreTraps.filter((t) => t.bucket === BUCKET.EXCLUDE_INTEGRITY).length;
  const nHold = report.rawScoreTraps.filter((t) => t.bucket === BUCKET.HOLD_REVIEW).length;
  const nWeak = nTrap - nCopy - nHold; // below-bar / stub-gaming — genuine work, just weak
  if (nTrap || nMiss) {
    const breakdown = [];
    if (nCopy) breakdown.push(nCopy + " confirmed copying");
    if (nHold) breakdown.push(nHold + " needing integrity review");
    if (nWeak) breakdown.push(nWeak + " below-bar / stub-gaming");
    root.append(el("div", { class: "insight" },
      el("div", { class: "ico", text: "⚖️" }),
      el("p", null,
        "Hiring by raw leaderboard score would wrongly include ",
        el("b", { class: "bad", text: nTrap + (nTrap === 1 ? " high scorer" : " high scorers") + " who don't clear the bar" }),
        breakdown.length ? " (" + breakdown.join(", ") + ")" : "",
        " and miss ",
        el("b", { class: "good", text: nMiss + (nMiss === 1 ? " genuine solver" : " genuine solvers") }),
        ". The ranking below is integrity-adjusted: talent and integrity are scored separately, and confirmed copying excludes a candidate regardless of score.",
      ),
    ));
  }

  // recommended hires
  const hireBody = el("div", { class: "rows" });
  if (report.hires.length) report.hires.forEach((h) => hireBody.append(candidateRow(h, { rankField: "talent_rank" })));
  else hireBody.append(el("div", { class: "nodossier", text: "No candidates cleared the hiring bar on this contest." }));
  root.append(section("Recommended hires", c.hires + " of " + c.participants,
    "Strong genuine problem-solvers, ranked by integrity-adjusted talent. Green = clean record; amber = recommend after a short desk-check (a weak note only — never a blocker). Click a row for the evidence.",
    hireBody));

  // watch-outs (two-up)
  if (nTrap || nMiss) {
    const trapsCard = el("div", { class: "card bad" },
      el("h3", { text: "Raw-score traps" }),
      el("p", { class: "h-note", text: "High scorers a leaderboard hire would wrongly pick." }),
    );
    if (nTrap) report.rawScoreTraps.forEach((t) => trapsCard.append(el("div", { class: "mini" },
      el("div", null, el("span", { class: "m-name", text: t.name }), t.candidate_id ? el("span", { class: "m-id", text: t.candidate_id }) : null,
        el("div", { class: "m-why", text: t.why_not })),
      el("div", { class: "m-meta", text: "raw #" + t.raw_rank + " · " + t.total_score }),
    )));
    else trapsCard.append(el("div", { class: "nodossier", text: "None — the raw leaderboard top is clean." }));

    const missCard = el("div", { class: "card good" },
      el("h3", { text: "Missed by raw score" }),
      el("p", { class: "h-note", text: "Genuine solvers a same-depth score cut would skip." }),
    );
    if (nMiss) report.missedByRawScore.forEach((m) => missCard.append(el("div", { class: "mini" },
      el("div", null, el("span", { class: "m-name", text: m.name }), m.candidate_id ? el("span", { class: "m-id", text: m.candidate_id }) : null,
        el("div", { class: "m-why good", text: "talent #" + m.talent_rank + ", clean genuine work" })),
      el("div", { class: "m-meta", text: "raw #" + m.raw_rank + " · " + m.total_score }),
    )));
    else missCard.append(el("div", { class: "nodossier", text: "None — the score order already matches merit." }));

    root.append(section("What a leaderboard would get wrong", null, null, el("div", { class: "twoup" }, trapsCard, missCard)));
  }

  // compare to your shortlist
  root.append(buildCompare(report));

  // excluded — integrity (collapsible, with evidence)
  if (report.excluded.length || report.hold.length) {
    const exBody = el("div", { class: "rows" });
    report.hold.forEach((h) => exBody.append(candidateRow(h)));
    report.excluded.forEach((h) => exBody.append(candidateRow(h)));
    root.append(el("section", null, group("Excluded & held — integrity", report.excluded.length + report.hold.length, el("div", null,
      el("p", { class: "sec-note", text: "Confirmed copying (excluded) and integrity holds (manual review before any offer). Click a row for the conclusive evidence." }),
      exBody), false)));
  }

  // below the bar (collapsible)
  if (report.belowBar.length) {
    const bbBody = el("div", { class: "rows" });
    report.belowBar.forEach((h) => bbBody.append(candidateRow(h, { rankField: "talent_rank" })));
    root.append(el("section", null, group("Below the bar", report.belowBar.length, bbBody, false)));
  }
}

// ---- compare to your shortlist (client-side only, never stored/sent) ----
function buildCompare(report) {
  const ta = el("textarea", { placeholder: "Paste names or IDs, one per line or comma-separated…" });
  const out = el("div", { class: "cmp-out" });
  const run = () => {
    const raw = ta.value || "";
    const tokens = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    out.replaceChildren();
    if (!tokens.length) { out.classList.remove("show"); return; }
    // Match per-token so a typo (matches nobody) or an ambiguous substring
    // (matches several — e.g. a common surname) is SURFACED, never silently
    // treated as a clean pass.
    const matchesFor = (t) => {
      const tl = t.toLowerCase();
      return report.ranked.filter((cand) =>
        (cand.candidate_id || "").toLowerCase() === tl ||
        (cand.identity_key || "").toLowerCase() === tl ||
        cand.name.toLowerCase().includes(tl));
    };
    const pickedMap = new Map();
    const unmatched = [];
    const ambiguous = [];
    for (const t of tokens) {
      const m = matchesFor(t);
      if (!m.length) { unmatched.push(t); continue; }
      if (m.length > 1) ambiguous.push(t + " (" + m.length + ")");
      m.forEach((cand) => pickedMap.set(cand.identity_key, cand));
    }
    const picked = [...pickedMap.values()];
    const pickedIds = new Set(picked.map((p) => p.identity_key));
    const concerns = picked.filter((p) => !isHireBucket(p.bucket));
    const missedByYou = report.hires.filter((h) => !pickedIds.has(h.identity_key));

    out.append(el("p", { class: "h-note", text:
      picked.length + " candidate(s) matched · " + concerns.length + " the eval flags · " + missedByYou.length + " recommended candidates not on your list" }));
    if (unmatched.length) out.append(el("p", { class: "cmp-warn", text: unmatched.length + " of your entries matched nobody (check spelling, or use the ID): " + unmatched.join(", ") }));
    if (ambiguous.length) out.append(el("p", { class: "cmp-warn", text: "Matched multiple — refine to an ID: " + ambiguous.join(", ") }));
    const twoup = el("div", { class: "twoup" });
    const cCard = el("div", { class: "card bad" }, el("h3", { text: "Your picks the eval would NOT clear" }));
    if (concerns.length) concerns.forEach((p) => cCard.append(el("div", { class: "mini" },
      el("div", null, el("span", { class: "m-name", text: p.name }), el("span", { class: "m-id", text: p.candidate_id || "" })),
      el("div", { class: "m-why", text: p.bucket_label }))));
    else cCard.append(el("div", { class: "nodossier", text: "None — every matched pick clears the bar." }));
    const mCard = el("div", { class: "card good" }, el("h3", { text: "Strong hires you didn't list" }));
    if (missedByYou.length) missedByYou.slice(0, 12).forEach((h) => mCard.append(el("div", { class: "mini" },
      el("div", null, el("span", { class: "m-name", text: h.name }), el("span", { class: "m-id", text: h.candidate_id || "" })),
      el("div", { class: "m-meta", text: "talent #" + h.talent_rank }))));
    else mCard.append(el("div", { class: "nodossier", text: "None — you listed every recommended hire." }));
    twoup.append(cCard, mCard);
    out.append(twoup);
    out.classList.add("show");
  };
  ta.addEventListener("input", run);
  const wrap = el("div", { class: "compare" }, ta,
    el("p", { class: "hint", text: "Compares your shortlist against the eval. Stays in your browser — never stored or sent." }), out);
  return el("section", null, group("Compare to your shortlist", "optional", wrap, false));
}

// boot
load();

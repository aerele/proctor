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

// recommended-hires filter: 'all' | 'strong_hire' | 'hire_deskcheck'
let hireFilter = "all";

// ---- CSV export (client-side; the already-authed admin downloads locally) ----
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name, headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function stamp() {
  try { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"); } catch (e) { return "export"; }
}
function csvName(list) {
  return (CONTEST || "contest") + "-" + list + "-" + stamp() + ".csv";
}
// a small "⤓ CSV" button that exports headers+rows when clicked
function csvBtn(list, headers, rowsFn) {
  return el("button", {
    class: "csvbtn", type: "button", title: "Download this list as CSV",
    onClick: (e) => { e.stopPropagation(); e.preventDefault(); downloadCsv(csvName(list), headers, rowsFn()); },
  }, "⤓ CSV");
}
// standard per-candidate CSV columns
const CAND_HEADERS = ["talent_rank", "raw_rank", "name", "id", "talent_composite", "talent_tier", "integrity", "confidence", "recommendation", "raw_score", "max_score", "reason", "peers"];
function candCsvRow(c) {
  const peers = (c.peer_evidence || []).map((p) => p.peer_name + (p.n_problems ? " (" + p.n_problems + "p" + (p.n_hard ? "/" + p.n_hard + "h" : "") + ")" : "")).join("; ");
  return [c.talent_rank, c.raw_rank, c.name, c.candidate_id, c.composite, c.talent_tier, c.integrity_tier, c.confidence, c.bucket_label, c.total_score, c.max_total, c.reason, peers];
}

// ---- resilient "Evaluate now" batch loop (mirrors frontend evalBatchLoop) ----
const EVAL_BACKOFF = [2000, 5000, 10000];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function runEvaluation(onProgress) {
  const pw = localStorage.getItem(PW_KEY);
  if (!pw) { showGate(); return "auth"; }
  let cursor = "";
  let retries = 0;
  for (let guard = 0; guard < 100000; guard++) {
    let res;
    try {
      res = await fetch("/api/admin/contest-evaluate", {
        method: "POST",
        headers: { "x-admin-password": pw, "content-type": "application/json" },
        body: JSON.stringify(cursor ? { contest: CONTEST, limit: 25, cursor } : { contest: CONTEST, limit: 25 }),
      });
    } catch (e) {
      if (retries >= EVAL_BACKOFF.length) throw new Error("network error");
      await sleep(EVAL_BACKOFF[retries++]);
      continue;
    }
    if (res.status === 401 || res.status === 403) { localStorage.removeItem(PW_KEY); showGate("That password was rejected. Try again."); return "auth"; }
    if (res.status === 409) { const j = await res.json().catch(() => ({})); throw new Error("A run is already in progress (" + (j.processed || 0) + "/" + (j.total || 0) + ") — try again shortly."); }
    if (res.status >= 500 || res.status === 429) {
      if (retries >= EVAL_BACKOFF.length) throw new Error("evaluation service error (" + res.status + ")");
      await sleep(EVAL_BACKOFF[retries++]);
      continue;
    }
    if (!res.ok) throw new Error("evaluate failed (" + res.status + ")");
    retries = 0;
    const j = await res.json();
    if (onProgress && typeof j.processed === "number") onProgress(j.processed, j.total || 0);
    if (j.done) return "done";
    cursor = j.cursor || "";
  }
  throw new Error("evaluation did not finish");
}

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

// opts: { id, controls: [Node] } — controls render right-aligned in the header
// (filter pills, CSV button, …).
function section(title, count, note, body, opts) {
  opts = opts || {};
  const head = el("div", { class: "sec-head" },
    el("h2", { text: title }),
    count != null ? el("span", { class: "count", text: count }) : null,
    opts.controls && opts.controls.length ? el("div", { class: "sec-controls" }, ...opts.controls) : null,
  );
  const sec = el("section", opts.id ? { id: opts.id } : null, head);
  if (note) sec.append(el("p", { class: "sec-note", text: note }));
  sec.append(body);
  return sec;
}

function group(title, count, body, open, opts) {
  opts = opts || {};
  const d = el("details", { class: "group" });
  if (opts.id) d.setAttribute("id", opts.id);
  if (open) d.setAttribute("open", "true");
  const summary = el("summary", null, el("span", { class: "caret", text: "▶" }), title, el("span", { class: "count", text: "(" + count + ")" }));
  if (opts.controls && opts.controls.length) summary.append(el("span", { class: "sec-controls inline" }, ...opts.controls));
  d.append(summary);
  d.append(body);
  return d;
}

function scrollToId(id) {
  const e = document.getElementById(id);
  if (!e) return;
  if (e.tagName === "DETAILS") e.open = true;
  e.scrollIntoView({ behavior: "smooth", block: "start" });
}

// the recommended-hires filter pill
function filterPill(label, value, count) {
  return el("button", {
    class: "pill" + (hireFilter === value ? " active" : ""), type: "button",
    onClick: () => { hireFilter = value; render(lastReport); scrollToId("sec-hires"); },
  }, label + (count != null ? " (" + count + ")" : ""));
}

// the header "Evaluate now" control (re-runs the batched evaluator + reloads)
function buildEvalNow(report) {
  const status = el("span", { class: "evalstatus", text: report && report.generated_from ? "last run " + String(report.generated_from).replace("T", " ").slice(0, 16) + "Z" : "" });
  const btn = el("button", { class: "btn-eval", type: "button" }, "Evaluate now");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    status.textContent = "";
    btn.textContent = "Evaluating…";
    try {
      const r = await runEvaluation((p, t) => { btn.textContent = "Evaluating " + p + (t ? " / " + t : "") + "…"; });
      if (r === "done") { status.textContent = "done"; await load(); return; }
      if (r === "auth") return;
    } catch (e) {
      status.textContent = String((e && e.message) || e);
      btn.disabled = false;
      btn.textContent = "Evaluate now";
    }
  });
  return el("span", { class: "evalwrap" }, btn, status);
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
      buildEvalNow(report),
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

  // chips — clickable: hire chips filter the recommended list; the others jump to
  // their section.
  const chip = (cls, n, label, onClick, active) =>
    el("button", { class: "chip " + cls + (onClick ? " clickable" : "") + (active ? " active" : ""), type: "button", onClick },
      el("b", { text: String(n) }), " " + label);
  const toggleFilter = (f) => { hireFilter = hireFilter === f ? "all" : f; render(lastReport); scrollToId("sec-hires"); };
  const chips = el("div", { class: "chips" },
    chip("good", c.strong_hire, "strong hire", () => toggleFilter("strong_hire"), hireFilter === "strong_hire"),
    chip("warn", c.hire_deskcheck, "hire · desk-check", () => toggleFilter("hire_deskcheck"), hireFilter === "hire_deskcheck"),
    c.hold_review ? chip("warn", c.hold_review, "hold · review", () => scrollToId("sec-excluded")) : null,
    chip("bad", c.exclude_integrity, "excluded · integrity", () => scrollToId("sec-excluded")),
    chip("", c.below_bar, "below bar", () => scrollToId("sec-below")),
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

  // recommended hires (filterable: All / Strong / Desk-check)
  const filteredHires = hireFilter === "all" ? report.hires : report.hires.filter((h) => h.bucket === hireFilter);
  const hireBody = el("div", { class: "rows" });
  if (filteredHires.length) filteredHires.forEach((h) => hireBody.append(candidateRow(h, { rankField: "talent_rank" })));
  else hireBody.append(el("div", { class: "nodossier", text: report.hires.length ? "No candidates match this filter." : "No candidates cleared the hiring bar on this contest." }));
  const hireControls = [
    filterPill("All", "all", report.hires.length),
    filterPill("Strong", "strong_hire", c.strong_hire),
    filterPill("Desk-check", "hire_deskcheck", c.hire_deskcheck),
    csvBtn("recommended-hires", CAND_HEADERS, () => filteredHires.map(candCsvRow)),
  ];
  root.append(section("Recommended hires", c.hires + " of " + c.participants,
    "Strong genuine problem-solvers, ranked by integrity-adjusted talent. Green = clean record; amber = recommend after a short desk-check (a weak note only — never a blocker). Click a row for the evidence.",
    hireBody, { id: "sec-hires", controls: hireControls }));

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

    const wrongCsv = csvBtn("leaderboard-would-get-wrong", ["kind", "name", "id", "raw_rank", "raw_score", "talent_rank", "talent_composite", "integrity", "detail"],
      () => [
        ...report.rawScoreTraps.map((t) => ["trap", t.name, t.candidate_id, t.raw_rank, t.total_score, t.talent_rank, t.composite, t.integrity_tier, t.why_not]),
        ...report.missedByRawScore.map((m) => ["missed", m.name, m.candidate_id, m.raw_rank, m.total_score, m.talent_rank, m.composite, m.integrity_tier, "clean genuine work"]),
      ]);
    root.append(section("What a leaderboard would get wrong", null, null, el("div", { class: "twoup" }, trapsCard, missCard), { controls: [wrongCsv] }));
  }

  // compare to your shortlist
  root.append(buildCompare(report));

  // excluded — integrity (collapsible, with evidence)
  if (report.excluded.length || report.hold.length) {
    const exBody = el("div", { class: "rows" });
    report.hold.forEach((h) => exBody.append(candidateRow(h)));
    report.excluded.forEach((h) => exBody.append(candidateRow(h)));
    const exCsv = csvBtn("excluded-and-held", CAND_HEADERS, () => report.hold.concat(report.excluded).map(candCsvRow));
    root.append(el("section", null, group("Excluded & held — integrity", report.excluded.length + report.hold.length, el("div", null,
      el("p", { class: "sec-note", text: "Confirmed copying (excluded) and integrity holds (manual review before any offer). Click a row for the conclusive evidence." }),
      exBody), false, { id: "sec-excluded", controls: [exCsv] })));
  }

  // below the bar (collapsible)
  if (report.belowBar.length) {
    const bbBody = el("div", { class: "rows" });
    report.belowBar.forEach((h) => bbBody.append(candidateRow(h, { rankField: "talent_rank" })));
    const bbCsv = csvBtn("below-the-bar", CAND_HEADERS, () => report.belowBar.map(candCsvRow));
    root.append(el("section", null, group("Below the bar", report.belowBar.length, bbBody, false, { id: "sec-below", controls: [bbCsv] })));
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
    out.append(csvBtn("shortlist-comparison",
      ["list", "name", "id", "recommendation", "status", "talent_rank", "talent_composite", "integrity"],
      () => [
        ...picked.map((p) => ["your_pick", p.name, p.candidate_id, p.bucket_label, isHireBucket(p.bucket) ? "clears the bar" : "flagged by eval", p.talent_rank, p.composite, p.integrity_tier]),
        ...missedByYou.map((h) => ["missed_by_you", h.name, h.candidate_id, h.bucket_label, "recommended (not on your list)", h.talent_rank, h.composite, h.integrity_tier]),
      ]));
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

// backend/src/evalUiPage.mjs — the /eval-ui page shell + asset loader.
//
// EVAL-EXCLUSIVE. Served only by proctor-eval (eval-server.mjs), embedded by the
// proctor-web "Evaluation" tab in an iframe (contract: iframe src
// `${evalApiBaseUrl}/eval-ui?contest=<slug>`, NO auth/token passed in — see
// eval-server.mjs). The page therefore SELF-AUTHENTICATES: it asks for the admin
// password once (kept in its OWN-origin localStorage), and replays it as
// x-admin-password on its same-origin fetch to GET /api/admin/contest-evaluations.
//
// The recommendation logic is NOT duplicated here: the page imports the SAME pure
// module the node tests pin (evaluationRecommend.mjs), served verbatim at
// /eval-ui/recommend.js. The client app is /eval-ui/app.js (evalUiClient.js).
//
// SECURITY: the shell is fully STATIC (no server-side interpolation of the slug —
// the client reads ?contest itself), so there is no server-side XSS surface here.
// The client renders all candidate names via textContent (never innerHTML), so
// PII cannot inject markup. The data (names + integrity verdicts) only ever loads
// AFTER a correct admin password — the page shows nothing privileged unauthd.
import { readFileSync } from "node:fs";

// Lazy, cached read of a sibling source file so eval-server can serve it as a
// browser asset (the file ships in the image next to this module).
const _assetCache = new Map();
export function loadAsset(filename) {
  if (_assetCache.has(filename)) return _assetCache.get(filename);
  const text = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
  _assetCache.set(filename, text);
  return text;
}

export function getRecommendModuleSource() {
  return loadAsset("evaluationRecommend.mjs");
}
export function getClientAppSource() {
  return loadAsset("evalUiClient.js");
}

// The static page shell. Inline CSS (light theme matching the proctor admin
// palette: ink #0a1a3f, accent #059669, warning #b45309, danger #b91c1c, line
// #e4e9f5). All dynamic content is built by /eval-ui/app.js.
export const EVAL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Evaluation</title>
<style>
  :root {
    --ink: #0a1a3f; --muted: #64748b; --paper: #f7f8fb; --panel: #ffffff;
    --line: #e4e9f5; --accent: #059669; --accent-soft: #ecfdf5; --accent-line: #a7f3d0;
    --warn: #b45309; --warn-soft: #fffbeb; --warn-line: #fde68a;
    --danger: #b91c1c; --danger-soft: #fef2f2; --danger-line: #fecaca;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); background: var(--paper);
    -webkit-font-smoothing: antialiased; line-height: 1.5;
  }
  .app { max-width: 1120px; margin: 0 auto; padding: 28px 24px 64px; }
  a { color: var(--accent); }

  /* header */
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { margin: 0; font-size: 24px; font-weight: 680; letter-spacing: -0.02em; }
  .served { font-size: 12px; color: var(--muted); }
  .sub { margin: 2px 0 20px; font-size: 14px; color: var(--muted); }

  /* summary chips */
  .chips { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 22px; }
  .chip { display: inline-flex; align-items: baseline; gap: 7px; padding: 8px 13px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 999px; font-size: 13px; box-shadow: var(--shadow); }
  .chip b { font-size: 15px; font-weight: 680; }
  .chip.good b { color: var(--accent); } .chip.warn b { color: var(--warn); } .chip.bad b { color: var(--danger); }

  /* headline insight banner */
  .insight { display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; border-radius: 14px;
    background: linear-gradient(180deg,#fbfdff,#f4f7fc); border: 1px solid var(--line); box-shadow: var(--shadow); margin-bottom: 26px; }
  .insight .ico { font-size: 22px; line-height: 1.1; }
  .insight p { margin: 0; font-size: 14.5px; }
  .insight b.bad { color: var(--danger); } .insight b.good { color: var(--accent); }

  section { margin-bottom: 30px; }
  .sec-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 4px; }
  .sec-head h2 { margin: 0; font-size: 17px; font-weight: 660; letter-spacing: -0.01em; }
  .sec-head .count { font-size: 13px; color: var(--muted); }
  .sec-note { margin: 0 0 14px; font-size: 13px; color: var(--muted); }

  /* candidate rows */
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .row { background: var(--panel); border: 1px solid var(--line); border-left-width: 4px; border-radius: 11px;
    box-shadow: var(--shadow); overflow: hidden; }
  .row.good { border-left-color: var(--accent); } .row.warn { border-left-color: var(--warn); }
  .row.bad { border-left-color: var(--danger); } .row.muted { border-left-color: #cbd5e1; }
  .row > summary { list-style: none; cursor: pointer; display: grid;
    grid-template-columns: 34px 1fr auto; gap: 14px; align-items: center; padding: 13px 16px; }
  .row > summary::-webkit-details-marker { display: none; }
  .rank { font-size: 14px; font-weight: 680; color: var(--muted); text-align: center; }
  .who { min-width: 0; }
  .who .name { font-weight: 640; font-size: 15px; letter-spacing: -0.01em; }
  .who .id { font-size: 12px; color: var(--muted); margin-left: 7px; font-variant: tabular-nums; }
  .who .reason { font-size: 13px; color: #475569; margin-top: 2px; }
  .right { display: flex; align-items: center; gap: 14px; }
  .scorewrap { text-align: right; min-width: 116px; }
  .bar { height: 6px; width: 110px; background: #eef2f8; border-radius: 999px; overflow: hidden; margin-top: 5px; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
  .row.bad .bar > i { background: var(--danger); } .row.warn .bar > i { background: var(--warn); }
  .row.muted .bar > i { background: #94a3b8; }
  .scoreline { font-size: 12px; color: var(--muted); font-variant: tabular-nums; }
  .scoreline b { color: var(--ink); font-size: 14px; }

  .badge { font-size: 11.5px; font-weight: 620; padding: 3px 9px; border-radius: 999px; white-space: nowrap; border: 1px solid transparent; }
  .badge.clean { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }
  .badge.watch, .badge.inconclusive { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-line); }
  .badge.flag, .badge.confirmed { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-line); }
  .badge.tier { color: #334155; background: #f1f5f9; border-color: #e2e8f0; }

  /* dossier (expanded) */
  .dossier { padding: 4px 16px 16px 64px; border-top: 1px solid var(--line); background: #fcfdff; }
  .dossier .one-line { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #475569; margin: 12px 0; }
  .flag { display: flex; gap: 9px; align-items: flex-start; padding: 7px 0; border-top: 1px dashed var(--line); font-size: 13px; }
  .flag:first-of-type { border-top: none; }
  .flag .sev { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 6px; margin-top: 1px; white-space: nowrap; }
  .flag .sev.critical { color: var(--danger); background: var(--danger-soft); }
  .flag .sev.warning { color: var(--warn); background: var(--warn-soft); }
  .flag .sev.info { color: var(--muted); background: #f1f5f9; }
  .flag .ftext .fl-label { font-weight: 560; }
  .flag .ftext .fl-weak { color: var(--warn); font-size: 11.5px; margin-left: 6px; }
  .flag .ftext .fl-ev { color: var(--muted); font-size: 12px; margin-top: 1px; }
  .flag .ftext .fl-pid { color: var(--muted); font-size: 11.5px; }
  .nodossier { color: var(--muted); font-size: 13px; padding: 10px 0; }

  /* two-up watchouts */
  .twoup { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 760px) { .twoup { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 13px; box-shadow: var(--shadow); padding: 16px 18px; }
  .card.bad { border-top: 3px solid var(--danger); } .card.good { border-top: 3px solid var(--accent); }
  .card h3 { margin: 0 0 3px; font-size: 15px; font-weight: 650; }
  .card .h-note { margin: 0 0 12px; font-size: 12.5px; color: var(--muted); }
  .mini { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13.5px; }
  .mini:first-of-type { border-top: none; }
  .mini .m-name { font-weight: 560; } .mini .m-id { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .mini .m-why { font-size: 12px; color: var(--danger); }
  .mini .m-why.good { color: var(--accent); }
  .mini .m-meta { font-size: 12px; color: var(--muted); font-variant: tabular-nums; white-space: nowrap; }

  /* collapsible groups */
  details.group { background: transparent; }
  details.group > summary { cursor: pointer; list-style: none; font-size: 15px; font-weight: 620; padding: 6px 0; color: var(--ink); }
  details.group > summary::-webkit-details-marker { display: none; }
  details.group > summary .caret { display: inline-block; transition: transform .15s; color: var(--muted); margin-right: 6px; }
  details.group[open] > summary .caret { transform: rotate(90deg); }
  details.group > summary .count { font-size: 13px; color: var(--muted); font-weight: 400; margin-left: 6px; }

  /* shortlist compare */
  .compare textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; color: var(--ink); background: var(--panel); }
  .compare .hint { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
  .compare .cmp-out { margin-top: 14px; display: none; }
  .compare .cmp-out.show { display: block; }

  /* auth gate + states */
  .overlay { min-height: 78vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .gate { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: var(--shadow); padding: 28px 26px; text-align: center; }
  .gate h2 { margin: 0 0 4px; font-size: 18px; }
  .gate p { margin: 0 0 18px; font-size: 13px; color: var(--muted); }
  .gate input { width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; font-size: 14px; margin-bottom: 12px; }
  .gate input:focus { outline: 2px solid var(--accent-line); border-color: var(--accent); }
  .gate button, .btn { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 11px 16px; font-size: 14px; font-weight: 620; cursor: pointer; width: 100%; }
  .gate button:hover, .btn:hover { filter: brightness(.96); }
  .gate .err { color: var(--danger); font-size: 13px; margin: 0 0 12px; min-height: 16px; }
  .state { padding: 48px 24px; text-align: center; color: var(--muted); font-size: 14px; }
  .spin { width: 22px; height: 22px; border: 2.5px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
    display: inline-block; animation: sp .8s linear infinite; vertical-align: middle; margin-right: 9px; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .topbtns { display: flex; gap: 8px; }
  .linkbtn { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; width: auto; }
  .linkbtn:hover { color: var(--ink); border-color: var(--muted); }

  /* methodology note — neutral/muted (NOT a green result banner): it describes a
     prior validation of the ruleset, not this contest's results, so it must not
     read as a headline number for this contest. */
  .calib { display: flex; gap: 7px; align-items: baseline; flex-wrap: wrap; padding: 9px 13px; background: #f8fafc;
    border: 1px solid var(--line); border-left: 3px solid #cbd5e1; border-radius: 9px; font-size: 12px; color: var(--muted); margin: 0 0 18px; }
  .calib .ck { font-weight: 650; color: #475569; }

  /* twin-pairs (the conclusive copying receipt, inside the case-against) */
  .twin { padding: 8px 10px; margin: 0 0 8px; background: var(--danger-soft); border: 1px solid var(--danger-line); border-radius: 8px; }
  .twin-head { font-size: 13px; }
  .twin-head b { color: var(--danger); }
  .twin-id { color: var(--muted); font-size: 11.5px; margin-left: 6px; font-variant: tabular-nums; }
  .twin-meta { font-size: 12px; color: #7f1d1d; margin-top: 2px; }

  /* compare-shortlist warnings (unmatched / ambiguous entries) */
  .cmp-warn { font-size: 12px; color: var(--warn); margin: 4px 0 0; }

  /* shadow-leaderboard movement chip */
  .deltachip { font-size: 11px; font-weight: 650; padding: 2px 8px; border-radius: 999px; white-space: nowrap; font-variant: tabular-nums; border: 1px solid transparent; }
  .deltachip.up { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }
  .deltachip.down { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-line); }
  .deltachip.flat { color: var(--muted); background: #f1f5f9; border-color: #e2e8f0; }
  .conf-note { font-size: 11.5px; color: var(--warn); margin-top: 2px; }

  /* dossier FOR/AGAINST case */
  .case2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 4px; }
  @media (max-width: 680px) { .case2 { grid-template-columns: 1fr; } }
  .casecard h4 { margin: 0 0 8px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .casecard.forc h4 { color: var(--accent); } .casecard.against h4 { color: var(--danger); }
  .for-item { font-size: 13px; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; }
  .for-item .tick { color: var(--accent); font-weight: 700; }
  .reassure { font-size: 12px; color: var(--warn); margin-top: 9px; font-style: italic; line-height: 1.45; }

  /* Evaluate-now control (header) */
  .evalwrap { display: inline-flex; align-items: center; gap: 8px; }
  .btn-eval { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 6px 13px; font-size: 12.5px; font-weight: 620; cursor: pointer; width: auto; white-space: nowrap; }
  .btn-eval:hover { filter: brightness(.96); }
  .btn-eval:disabled { opacity: .7; cursor: default; }
  .evalstatus { font-size: 11.5px; color: var(--muted); max-width: 220px; }

  /* section header controls (filter pills + CSV, right-aligned) */
  .sec-head { flex-wrap: wrap; }
  .sec-controls { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sec-controls.inline { margin-left: 10px; display: inline-flex; }
  .pill { background: var(--panel); border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 3px 11px; font-size: 12px; cursor: pointer; width: auto; }
  .pill:hover { border-color: var(--muted); color: var(--ink); }
  .pill.active { background: var(--ink); border-color: var(--ink); color: #fff; }
  .csvbtn { background: var(--panel); border: 1px solid var(--line); color: #475569; border-radius: 8px; padding: 3px 10px; font-size: 11.5px; font-weight: 600; cursor: pointer; width: auto; white-space: nowrap; }
  .csvbtn:hover { border-color: var(--accent); color: var(--accent); }

  /* clickable summary chips */
  .chip.clickable { cursor: pointer; }
  .chip.clickable:hover { border-color: var(--muted); }
  .chip.active { outline: 2px solid var(--ink); outline-offset: 1px; }
  .chip.good.active { outline-color: var(--accent); }
  .chip.warn.active { outline-color: var(--warn); }
</style>
</head>
<body>
  <div id="root" class="app"></div>
  <script type="module" src="/eval-ui/app.js"></script>
</body>
</html>`;

// frontend/scripts/shots-to-docs.mjs
// Promotes the CURATED subset of freshly-generated Playwright baselines into the
// public docs corpus at docs/assets/<section>/, mirroring the existing
// docs/assets/e2e naming. Run after `playwright test` (see the `shots:docs`
// script) so a doc screenshot is byte-identical to what the regression gate
// guards — both come from the SAME demo build + fixtures.
//
// Source = the committed baselines under tests/visual/__screenshots__/<spec>/.
// We copy the platform-suffixed PNG Playwright actually wrote (e.g.
// "<name>-chromium-linux.png") to a clean, suffix-free doc filename.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(__dirname, "..");
const SHOTS = path.join(FRONTEND, "tests", "visual", "__screenshots__");
const DOCS = path.resolve(FRONTEND, "..", "docs", "assets", "harness");

// CURATED MAP: { specFile, baselineName } -> docs/assets/<section>/<file>.png.
// Sections mirror the manual corpus (admin-review / candidate / invigilator /
// evaluation). Add a row here to publish a new shot.
const MAP = [
  // --- admin (Live + Contest + Evidence + Authoring + People + Health + Settings)
  ["admin.spec.ts", "admin-01-stats", "admin-review/01-live-stats"],
  ["admin.spec.ts", "admin-02-alerts", "admin-review/04-alerts-console"],
  ["admin.spec.ts", "admin-03-sessions", "admin-review/02-sessions"],
  ["admin.spec.ts", "admin-04-ips", "admin-review/05-ip-report"],
  ["admin.spec.ts", "admin-05-contests", "admin-setup/08-contests"],
  ["admin.spec.ts", "admin-06-attendance", "admin-review/06-attendance"],
  ["admin.spec.ts", "admin-07-results", "admin-review/07-results-ranked-table"],
  ["admin.spec.ts", "admin-08-evaluation", "admin-review/10-evaluation-tab"],
  ["admin.spec.ts", "admin-09-review", "admin-review/03-review-dashboard"],
  ["admin.spec.ts", "admin-10-recordings", "admin-review/03b-recordings"],
  ["admin.spec.ts", "admin-11-problems", "admin-setup/02-problem-bank"],
  ["admin.spec.ts", "admin-12-templates", "admin-setup/05-templates"],
  ["admin.spec.ts", "admin-13-people", "admin-review/08-people-directory"],
  ["admin.spec.ts", "admin-14-health", "admin-setup/12-system-health-idle"],
  ["admin.spec.ts", "admin-15-settings", "admin-setup/13-settings"],
  // --- admin targeted detail views
  ["admin.spec.ts", "admin-session-detail-card", "admin-review/02-session-detail"],
  ["admin.spec.ts", "admin-results-row-selected", "admin-review/07b-results-row-selected"],
  ["admin.spec.ts", "admin-people-scorecard", "admin-review/08a-people-scorecard"],
  ["admin.spec.ts", "admin-ip-drilldown", "admin-review/05-ip-report-drilldown"],
  ["admin.spec.ts", "admin-alerts-console", "admin-review/04a-alerts-grouped"],
  ["admin.spec.ts", "admin-health-verdict", "admin-setup/12b-system-health-verdict"],
  // --- evaluation iframe
  ["evaluation.spec.ts", "admin-evaluation-iframe", "evaluation/01-recommendation-report"],
  // --- candidate
  ["candidate.spec.ts", "candidate-01-access-code", "candidate/00-access-code"],
  ["candidate.spec.ts", "candidate-02-permissions-gate", "candidate/01-permissions-gate"],
  ["candidate.spec.ts", "candidate-03-details-roster", "candidate/03-details-roster"],
  ["candidate.spec.ts", "candidate-04-details-filled", "candidate/04-details-filled"],
  // --- invigilator
  ["invigilator.spec.ts", "invigilator-01-portal-entry", "invigilator/01-portal-entry"],
  ["invigilator.spec.ts", "invigilator-02-room-picker", "invigilator/02-room-picker"],
  ["invigilator.spec.ts", "invigilator-03-room-console-dashboard", "invigilator/03-room-console-dashboard"]
];

// Find the platform-suffixed PNG Playwright wrote for a logical baseline name.
function resolveBaseline(specDir, baseName) {
  if (!existsSync(specDir)) return null;
  const exact = path.join(specDir, baseName + ".png");
  if (existsSync(exact)) return exact;
  const hit = readdirSync(specDir).find((f) => f.startsWith(baseName + "-") && f.endsWith(".png"));
  return hit ? path.join(specDir, hit) : null;
}

let copied = 0;
const missing = [];
for (const [spec, baseName, dest] of MAP) {
  const src = resolveBaseline(path.join(SHOTS, spec), baseName);
  if (!src) {
    missing.push(`${spec}:${baseName}`);
    continue;
  }
  const out = path.join(DOCS, dest + ".png");
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(src, out);
  copied++;
  console.log(`  ${path.relative(FRONTEND, src)}  ->  docs/assets/harness/${dest}.png`);
}

console.log(`\nshots-to-docs: copied ${copied}/${MAP.length} curated shots into docs/assets/harness/.`);
if (missing.length) {
  console.warn(`WARNING: ${missing.length} baseline(s) not found (run \`npm run shots:update\` first):`);
  for (const m of missing) console.warn(`  - ${m}`);
  process.exitCode = 1;
}

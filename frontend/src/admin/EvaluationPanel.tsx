// frontend/src/admin/EvaluationPanel.tsx
// The contest admin "Evaluation" view. By design this SPA renders NOTHING of the
// evaluation content itself — the entire page is served by the separate
// proctor-eval Cloud Run service at GET ${evalApiBaseUrl}/eval-ui and merely
// EMBEDDED here in an iframe. That isolation lets the eval team rewrite the P3
// evaluation output AND its page freely, post-P3, with ZERO frontend/API change:
// the only contract this component depends on is the embed URL shape
// (`/eval-ui?contest=<slug>`), which is frozen now.
//
// No data fetching happens here, and `password` is intentionally unused for the
// embed (the placeholder page shows nothing privileged). When P3 renders real
// data, the eval page will authenticate to the eval API itself (a token passed
// from this parent frame), not via any new call in this component.
import { BrainCircuit } from "lucide-react";
import { evalApiBaseUrl } from "../api";

export function EvaluationPanel({ contestSlug }: { contestSlug: string }) {
  // The eval service owns the whole page; we only build the embed URL. The slug
  // is URL-encoded so an odd contest slug can never break the query string (the
  // eval page HTML-escapes it on its side, so there is no XSS surface here).
  const src = `${evalApiBaseUrl}/eval-ui?contest=${encodeURIComponent(contestSlug)}`;

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex items-center gap-3">
          <BrainCircuit size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Evaluation</h1>
            <p className="mt-1 text-sm text-muted">
              Served by the evaluation service
              {contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}.
              The page below is rendered entirely by proctor-eval and embedded here.
            </p>
          </div>
        </div>
      </div>

      <iframe
        title="Evaluation (served by the proctor-eval service)"
        src={src}
        className="w-full rounded-lg border border-line bg-panel"
        style={{ minHeight: "80vh" }}
      />
    </section>
  );
}

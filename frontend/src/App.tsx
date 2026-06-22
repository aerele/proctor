import { InvigilatorApp } from "./InvigilatorApp";
import { CandidateRouter } from "./candidate/CandidateRouter";
import { AdminApp } from "./admin/AdminApp";
import { TakeHomeGallery } from "./devtools/TakeHomeGallery";

// S4: the contest problem is SERVER-DRIVEN — it arrives as `problem` inside the
// start/resume response (the contest's problems[] → public view; see
// docs/design-history/specs/2026-06-09-s4-problem-authoring-design.md).
//
// Candidate-facing copy is surface-specific (studentCopy.ts): with a problem
// assigned, no student string may direct the candidate to HackerRank. The copy
// keys off ownEditorCopy (UX-H1): Boolean(sessionConfig?.problem) once a
// session exists, with a pinned ?contest= link selecting the own-editor
// variant pre-session too (pinned contests are own-editor sessions).

export function App() {
  // #135 take-home: a DEMO-ONLY screenshot gallery for the new remote screens.
  // Gated on VITE_DEMO_MODE so it is INERT in a production build (the route just
  // falls through to the candidate app) — pure test/doc infra, no product surface.
  if (
    import.meta.env.VITE_DEMO_MODE === "true" &&
    window.location.pathname.startsWith("/demo-gallery")
  ) {
    return <TakeHomeGallery />;
  }

  // S3: the invigilator portal lives on its own path, like /admin.
  if (window.location.pathname.startsWith("/invigilator")) return <InvigilatorApp />;
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminApp /> : <CandidateRouter />;
}


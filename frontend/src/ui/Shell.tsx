// frontend/src/ui/Shell.tsx
// Domain-free layout primitive (extracted from App.tsx, F1). Page container with
// the Aerele Proctor header chrome; variants tune width + bottom clearance.
import type React from "react";

export function Shell({ children, padTop = false, variant = "page" }: { children: React.ReactNode; padTop?: boolean | "alert"; variant?: "page" | "exam" | "wide" }) {
  const pad = padTop === "alert" ? "pt-40" : padTop ? "pt-14" : "";
  // The width cap: exam/wide get the roomy max-w-screen-2xl (calmer than full
  // bleed on ultrawide monitors, but ~2.5× the side room of max-w-6xl); exam
  // ALSO reserves bottom clearance for the fixed CameraDock.
  const containerWidth = variant === "exam" ? "max-w-screen-2xl pb-48" : variant === "wide" ? "max-w-screen-2xl" : "max-w-6xl";
  return (
    <main className={`min-h-screen bg-paper px-4 py-5 text-ink md:px-8 ${pad}`}>
      {/* UX-H2: the exam variant reserves bottom clearance (pb-48) so the
          fixed bottom-right CameraDock never covers end-of-page content
          (run results / verdict) once the candidate scrolls to the bottom. */}
      <div className={`mx-auto ${containerWidth}`}>
        {variant === "exam" ? null : (
          <header className="mb-5 flex items-center justify-between border-b border-line pb-4">
            <div className="flex items-center gap-3">
              <img src="/aerele-logo.png" alt="Aerele" className="h-9 w-9 rounded-md" />
              <div>
                <p className="text-sm font-semibold">Aerele Proctor</p>
                <p className="text-xs text-muted">Evidence collection for coding assessments</p>
              </div>
            </div>
          </header>
        )}
        {children}
      </div>
    </main>
  );
}

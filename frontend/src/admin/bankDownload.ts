// frontend/src/admin/bankDownload.ts
// BANK-1 (F11) UI — client-side JSON-bundle download. The bank-export endpoint
// returns the bundle INLINE (small, no PII — spec §4), so the browser saves it
// directly via a Blob + anchor click (same primitive as the roster-template /
// scorecard CSV downloads — Settings.downloadTemplate, PeoplePanel.downloadCsv).
// No new dependency, no GCS round-trip.

/** A filesystem-safe timestamp stamp for the default bundle filename. */
export function bundleStamp(now: Date = new Date()): string {
  // 2026-06-23T10-00-00 — colons stripped so it's a valid filename everywhere.
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/** Default download filename for a bundle. */
export function bundleFilename(now: Date = new Date()): string {
  return `proctor-bundle-${bundleStamp(now)}.json`;
}

/** Save an object as a pretty-printed .json file the browser downloads. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// frontend/src/admin/adminNav.ts
// W3: the admin top-level navigation MODEL. The old nav was 13 flat tabs
// wrapping onto two cluttered rows; this groups them into sections so the
// header renders ONE slim row of sections + one row of views for the active
// section (single-view sections skip the second row entirely). Pure data +
// lookups so the grouping is unit-testable without a render harness.

export type AdminView =
  | "stats"
  | "contests"
  | "templates"
  | "alerts"
  | "sessions"
  | "attendance"
  | "results"
  | "people"
  | "review"
  | "recordings"
  | "problems"
  | "settings"
  | "ips";

export type AdminNavGroup = {
  key: "live" | "contest" | "evidence" | "authoring" | "people" | "settings";
  label: string;
  views: ReadonlyArray<{ view: AdminView; label: string }>;
};

// Grouping rationale (ops-first ordering):
//   Live      — what the admin watches DURING the exam (stats/alerts/sessions/IPs)
//   Contest   — the administered round itself: setup, attendance, outcomes
//   Evidence  — post-hoc human review of candidates and recordings
//   Authoring — the cross-contest libraries (problem bank, templates)
//   People    — the cross-round person directory (single view)
//   Settings  — the legacy global gate (single view)
export const ADMIN_NAV_GROUPS: ReadonlyArray<AdminNavGroup> = [
  {
    key: "live",
    label: "Live",
    views: [
      { view: "stats", label: "Live stats" },
      { view: "alerts", label: "Live alerts" },
      { view: "sessions", label: "Sessions" },
      { view: "ips", label: "IP report" }
    ]
  },
  {
    key: "contest",
    label: "Contest",
    views: [
      { view: "contests", label: "Contests" },
      { view: "attendance", label: "Attendance" },
      { view: "results", label: "Results" }
    ]
  },
  {
    key: "evidence",
    label: "Evidence",
    views: [
      { view: "review", label: "Review" },
      { view: "recordings", label: "Recordings" }
    ]
  },
  {
    key: "authoring",
    label: "Authoring",
    views: [
      { view: "problems", label: "Problems" },
      { view: "templates", label: "Templates" }
    ]
  },
  { key: "people", label: "People", views: [{ view: "people", label: "People" }] },
  { key: "settings", label: "Settings", views: [{ view: "settings", label: "Settings" }] }
];

/** The group containing a view (every AdminView belongs to exactly one). */
export function groupOfView(view: AdminView): AdminNavGroup {
  const hit = ADMIN_NAV_GROUPS.find((group) => group.views.some((entry) => entry.view === view));
  // Unreachable by construction (the test below pins full coverage); the
  // fallback keeps the nav rendering even if a future view forgets its group.
  return hit ?? ADMIN_NAV_GROUPS[0];
}

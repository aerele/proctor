// frontend/src/sessionFilters.ts
// Shared admin Sessions status-filter type, extracted from App.tsx (F3) so both
// AdminApp (App.tsx) and the admin views (StatsDashboard/SessionsView) reference
// one definition without an App.tsx ↔ view import cycle.

// A2: the status a stat-card drill-down filters the Sessions list to. Mirrors the
// AdminStats card labels. "" = no status filter (the Total card). "disconnected"
// has no literal session-doc status (it is a derived liveness state), so the
// Sessions list treats it as the active sessions and shows an explanatory note.
export type SessionsStatusFilter = "" | "active" | "locked" | "pending_approval" | "ended" | "disconnected";

// frontend/src/admin/views/ContestScopePicker.tsx
// Global contest scope dropdown, extracted verbatim from App.tsx (F3).
import { ListFilter, X } from "lucide-react";
import type { ContestSummary } from "../../types";

// A1: GLOBAL CONTEST FILTER banner, rendered below the nav so it shows on EVERY
// tab. When a slug is set it shows an active chip with a Clear button; when empty
// it shows a compact labeled input. Applying/clearing rescopes Stats, Alerts,
// Sessions, and Recordings (the parent re-loads loaded data; the 5s poll re-keys
// for Stats/Alerts only). Sessions is NOT auto-polled — the poll effect guards on
// view==='stats'||'alerts' — so the parent re-loads the Sessions list explicitly
// (on tab-open, stat-card drill, status change, Refresh, and post-approve).
// S-D (A1): the real contest SELECTOR — a dropdown of every contest (legacy
// included) replacing the old type-a-slug banner. The selection scopes
// Sessions/Alerts/Recordings/IP/Attendance/Stats via the existing contest_slug
// filters and persists in this tab's URL. A selected slug that is not in the
// dropdown (deep link to an old/purged slug) renders as a literal option so
// the URL state is never silently dropped.
// W3: the global contest scope, compacted into the nav header's top-right
// corner — it filters EVERY admin screen, so it sits above all of them.
export function ContestScopePicker({ contests, contestSlug, onSelect }: {
  contests: ContestSummary[] | null;
  contestSlug: string;
  onSelect: (slug: string) => void;
}) {
  const known = contests ?? [];
  const unknownSelection = contestSlug && !known.some((contest) => contest.slug === contestSlug);
  return (
    <label
      className="flex items-center gap-2"
      title="Scopes every admin screen. The selection sticks to this browser tab's URL — open another tab for a second contest."
    >
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <ListFilter size={13} /> Contest
      </span>
      <select
        className="focus-ring h-8 max-w-[18rem] rounded-md border border-line bg-white px-2 text-sm"
        value={contestSlug}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">All contests</option>
        {known.map((contest) => (
          <option key={contest.slug} value={contest.slug}>
            {contest.name} ({contest.slug}) — {contest.status}
          </option>
        ))}
        {unknownSelection ? <option value={contestSlug}>{contestSlug} (unknown slug)</option> : null}
      </select>
      {contestSlug ? (
        <button
          type="button"
          onClick={() => onSelect("")}
          className="focus-ring inline-flex h-8 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-medium text-ink hover:border-ink/40"
          title="Back to all contests"
        >
          <X size={13} /> Clear
        </button>
      ) : null}
    </label>
  );
}

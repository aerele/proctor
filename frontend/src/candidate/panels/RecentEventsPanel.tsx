// frontend/src/candidate/panels/RecentEventsPanel.tsx
// Candidate leaf panels (extracted verbatim from App.tsx, F2). Props-driven.
import { ClipboardList } from "lucide-react";
import type { ProctorEvent } from "../../types";

// Recent proctor events — shared by the classic layout (bottom section) and
// the exam view's collapsible proctoring panel.
export function RecentEventsPanel({ events }: { events: ProctorEvent[] }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <ClipboardList size={18} />
        <h2 className="text-base font-semibold">Recent proctor events</h2>
      </div>
      <div className="space-y-2">
        {events.length ? events.map((event, index) => <EventRow key={`${event.timestamp}-${index}`} event={event} />) : <p className="text-sm text-muted">Events will appear after recording starts.</p>}
      </div>
    </section>
  );
}

export function EventRow({ event }: { event: ProctorEvent }) {
  // UX-M1: candidate-facing rows render the friendly message only — never the
  // raw detail JSON (it carries internals like upload storage keys). Admin
  // surfaces have their own event views and are unaffected.
  const message = typeof event.detail?.message === "string" ? event.detail.message : event.visibility_state;
  return (
    <div className="grid gap-2 rounded-md border border-line bg-white/60 p-3 text-sm md:grid-cols-[180px_180px_1fr]">
      <span className="font-mono text-xs text-muted">{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span className="font-medium">{event.type}</span>
      <span className="truncate text-muted">{message}</span>
    </div>
  );
}

// frontend/src/candidate/panels/IdentityCard.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven, no
// closures over StudentApp internals.
import { UserCheck } from "lucide-react";

// Prominent identity confirmation (Epic 3): the student sees exactly who the
// session is registered to before and during the test.
export function IdentityCard({ identity }: { identity: { name: string; candidate_id: string; room: string } }) {
  return (
    <section className="mb-5 rounded-lg border border-accent/40 bg-accent/5 p-5 shadow-subtle">
      <div className="flex flex-wrap items-center gap-3">
        <UserCheck size={22} className="text-accent" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">You are taking the test as</p>
          <p className="mt-1 text-lg font-semibold text-ink">
            {identity.name} <span className="font-mono text-base text-muted">({identity.candidate_id})</span>
          </p>
          <p className="mt-1 text-sm text-muted">Room {identity.room || "—"} · Confirm this is you. If anything is wrong, call a proctor before continuing.</p>
        </div>
      </div>
    </section>
  );
}

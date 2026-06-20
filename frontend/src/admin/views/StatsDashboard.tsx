// frontend/src/admin/views/StatsDashboard.tsx
// Live stats dashboard, extracted verbatim from App.tsx (F3).
import { Activity, CheckCircle2, Clock, Lock, MonitorUp, RefreshCw, ShieldCheck, Users } from "lucide-react";
import type { AdminStats } from "../../types";
import type { SessionsStatusFilter } from "../../sessionFilters";
import { StatCard } from "../../ui/StatCard";
import { RoomFilter } from "./RoomFilter";

export function StatsDashboard({ stats, loading, onRefresh, rooms, room, onRoomChange, onDrill }: { stats: AdminStats | null; loading: boolean; onRefresh: () => void; rooms: string[]; room: string; onRoomChange: (room: string) => void; onDrill: (status: SessionsStatusFilter) => void }) {
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ShieldCheck size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Live stats</h1>
              <p className="mt-1 text-sm text-muted">Current session counts by status across the contest. Auto-refreshes every 5s; Refresh to update now.</p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <RoomFilter rooms={rooms} value={room} onChange={onRoomChange} />
          {room ? <p className="text-xs text-muted">Counts scoped to room <span className="font-medium">{room}</span>.</p> : null}
        </div>
      </div>

      {stats === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading stats…" : "No stats loaded yet."}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <StatCard label="Live" value={stats.live} tone="accent" icon={<MonitorUp size={18} />} onClick={() => onDrill("active")} />
          <StatCard label="Disconnected" value={stats.disconnected ?? 0} tone="danger" icon={<Activity size={18} />} onClick={() => onDrill("disconnected")} />
          <StatCard label="Locked" value={stats.locked} tone="danger" icon={<Lock size={18} />} onClick={() => onDrill("locked")} />
          <StatCard label="Pending approval" value={stats.pending_approval} tone="warning" icon={<Clock size={18} />} onClick={() => onDrill("pending_approval")} />
          <StatCard label="Finished" value={stats.finished} tone="muted" icon={<CheckCircle2 size={18} />} onClick={() => onDrill("ended")} />
          <StatCard label="Total" value={stats.total} tone="ink" icon={<Users size={18} />} onClick={() => onDrill("")} />
          <StatCard label="Not started / total" value={stats.not_started_or_total ?? stats.total} tone="muted" icon={<Users size={18} />} />
        </div>
      )}
    </section>
  );
}

// frontend/src/InvigilatorApp.tsx
// S3 — the room invigilator portal (/invigilator). Unlock mirrors the admin
// gate (client-side verify, then the typed password rides x-invigilator-password
// on every call; the backend also accepts the admin credential). NO signed-QR
// ID verification here — that is DEFERRED by design; ID checks stay manual.
import { AlertTriangle, Bell, DoorOpen, KeyRound, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  adminPassword, adminPasswordHash,
  fetchInvigilatorOverview, fetchInvigilatorRoom,
  invigilatorPassword, invigilatorPasswordHash,
  openRoom, releaseRoomCode, sha256Hex
} from "./api";
import { gateStatusLabel } from "./invigilator/gateLogic";
import type { InvigilatorAlert, InvigilatorRoomResponse, InvigilatorSessionRow, RoomGate } from "./types";

const POLL_INTERVAL_MS = 5000;
const savedKey = "aerele-proctor-invigilator";
const UNASSIGNED_KEY = "_";
const UNASSIGNED_LABEL = "(no room set)";
const OTHER_CHOICE = "__other__";

type SavedIdentity = { name: string; room: string };

function readSaved(): SavedIdentity {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(savedKey) || "{}") as Partial<SavedIdentity>;
    return { name: String(parsed.name || ""), room: String(parsed.room || "") };
  } catch {
    return { name: "", room: "" };
  }
}

export function InvigilatorApp() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [name, setName] = useState(() => readSaved().name);
  // The API value for the selected room ("_" = the unassigned pseudo-room).
  const [room, setRoom] = useState(() => readSaved().room);
  const [roomChoice, setRoomChoice] = useState("");
  const [otherRoom, setOtherRoom] = useState("");
  const [rooms, setRooms] = useState<string[]>([]);
  const [hasUnassigned, setHasUnassigned] = useState(false);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [contestSlug, setContestSlug] = useState<string | null>(null);
  const [data, setData] = useState<InvigilatorRoomResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const saveIdentity = (nextRoom: string) => {
    window.localStorage.setItem(savedKey, JSON.stringify({ name: name.trim(), room: nextRoom }));
  };

  // Unlock: invigilator hash → invigilator plain → admin hash → admin plain
  // (an admin may open the portal with the admin credential).
  const unlock = async () => {
    setError("");
    if (!name.trim()) {
      setError("Enter your name — code releases are recorded against it.");
      return;
    }
    const typed = passwordInput;
    let ok = false;
    try {
      if (invigilatorPasswordHash && (await sha256Hex(typed)) === invigilatorPasswordHash) ok = true;
      if (!ok && adminPasswordHash && (await sha256Hex(typed)) === adminPasswordHash) ok = true;
    } catch {
      setError("This browser cannot hash the password (crypto.subtle unavailable).");
      return;
    }
    if (!ok && invigilatorPassword && typed === invigilatorPassword) ok = true;
    if (!ok && adminPassword && typed === adminPassword) ok = true;
    if (!ok) {
      setError("Invalid invigilator password.");
      return;
    }
    setPassword(typed);
    setUnlocked(true);
    setPasswordInput("");
    saveIdentity(room);
    try {
      const overview = await fetchInvigilatorOverview(typed);
      setRooms(overview.rooms);
      setHasUnassigned(overview.has_unassigned);
      setGateEnabled(overview.room_gate_enabled);
      setContestSlug(overview.contest_slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirmRoom = () => {
    const next = roomChoice === OTHER_CHOICE ? otherRoom.trim() : roomChoice;
    if (!next) return;
    if (room && next !== room
      && !window.confirm("Change rooms? Your view moves to the new room; past gate actions stay recorded under your name.")) {
      return;
    }
    setRoom(next);
    setData(null);
    saveIdentity(next);
  };

  // Room dashboard poll: ONE GET per 5 s returns stats + students + gate +
  // alerts (mirrors the admin auto-poll; transient poll errors are swallowed).
  useEffect(() => {
    if (!unlocked || !room) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetchInvigilatorRoom(password, room);
        if (cancelled) return;
        setData(response);
        setGateEnabled(response.room_gate_enabled);
        setContestSlug(response.contest_slug);
      } catch {
        // next tick or a manual action surfaces real errors
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [unlocked, room, password]);

  const release = async (regenerate: boolean) => {
    if (regenerate && !window.confirm("Generate a NEW code? The code currently on the board stops working.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await releaseRoomCode(password, room, name.trim(), regenerate);
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const startNow = async () => {
    if (!window.confirm("Start now for the WHOLE room? Every waiting candidate is admitted without a code.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await openRoom(password, room, name.trim());
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <PortalShell>
        <section className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-6 shadow-subtle">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-accent" />
            <h1 className="text-xl font-semibold text-ink">Invigilator portal</h1>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Room console: release the start code, start the room, watch who is recording, and read your room's alerts. ID checks are manual (no QR scanning).
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Your name</span>
              <input className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Invigilator password</span>
              <input
                className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                type="password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void unlock(); }}
              />
            </label>
            <button className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ink text-sm font-medium text-white" onClick={() => void unlock()}>
              Enter
            </button>
            {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
          </div>
        </section>
      </PortalShell>
    );
  }

  if (!room) {
    return (
      <PortalShell>
        <section className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-6 shadow-subtle">
          <h1 className="text-xl font-semibold text-ink">Pick your room</h1>
          <p className="mt-2 text-sm text-muted">{contestSlug ? `Contest: ${contestSlug}` : "No contest configured yet."}</p>
          <div className="mt-4 space-y-3">
            <select className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={roomChoice} onChange={(event) => setRoomChoice(event.target.value)}>
              <option value="">Select a room…</option>
              {rooms.map((label) => <option key={label} value={label}>{label}</option>)}
              {hasUnassigned ? <option value={UNASSIGNED_KEY}>{UNASSIGNED_LABEL}</option> : null}
              <option value={OTHER_CHOICE}>Other…</option>
            </select>
            {roomChoice === OTHER_CHOICE ? (
              <input className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" placeholder="Room label" value={otherRoom} onChange={(event) => setOtherRoom(event.target.value)} />
            ) : null}
            <button
              className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ink text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!roomChoice || (roomChoice === OTHER_CHOICE && !otherRoom.trim())}
              onClick={confirmRoom}
            >
              Open room console
            </button>
            {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
          </div>
        </section>
      </PortalShell>
    );
  }

  const roomLabel = room === UNASSIGNED_KEY ? UNASSIGNED_LABEL : room;
  const stats = data?.stats ?? null;

  return (
    <PortalShell>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor — Invigilator</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">Room {roomLabel}</h1>
          <p className="mt-1 text-sm text-muted">
            {name.trim()}{contestSlug ? ` · ${contestSlug}` : ""} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </p>
        </div>
        <button
          className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium"
          onClick={() => {
            if (window.confirm("Leave this room view and pick another room?")) {
              setRoom("");
              setRoomChoice("");
              setData(null);
              saveIdentity("");
            }
          }}
        >
          Change room
        </button>
      </header>

      {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      <div className="mt-5">
        <GateCard
          gate={data?.gate ?? null}
          gateEnabled={gateEnabled}
          busy={busy}
          onRelease={() => void release(false)}
          onRegenerate={() => void release(true)}
          onStartNow={() => void startNow()}
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatTile label="Recording" value={stats?.live ?? 0} tone="accent" />
        <StatTile label="Disconnected" value={stats?.disconnected ?? 0} tone="danger" />
        <StatTile label="Locked" value={stats?.locked ?? 0} tone="danger" />
        <StatTile label="Waiting approval" value={stats?.pending_approval ?? 0} tone="warning" />
        <StatTile label="Finished" value={stats?.finished ?? 0} />
        <StatTile label="Started exam" value={stats?.started ?? 0} tone="accent" />
        <StatTile label="Total" value={stats?.total ?? 0} />
      </div>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex items-center gap-2">
          <Users size={18} />
          <h2 className="text-base font-semibold">Students in this room</h2>
        </div>
        {data && data.sessions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Username</th>
                  <th className="py-2 pr-3">Roll no.</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Exam</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((row) => {
                  const badge = statusBadge(row);
                  return (
                    <tr key={row.session_id} className="border-b border-line/60">
                      <td className="py-2 pr-3 font-medium text-ink">{row.name || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{row.hackerrank_username || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{row.roll_number || "—"}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                      </td>
                      <td className="py-2 text-muted">{row.exam_started_at ? "Started" : "Waiting"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">{data ? "No sessions in this room yet." : "Loading…"}</p>
        )}
      </section>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex items-center gap-2">
          <Bell size={18} />
          <h2 className="text-base font-semibold">Room alerts</h2>
        </div>
        {data && data.alerts.length ? (
          <div className="space-y-2">
            {data.alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
          </div>
        ) : (
          <p className="text-sm text-muted">{data ? "No open alerts for this room." : "Loading…"}</p>
        )}
      </section>
    </PortalShell>
  );
}

function PortalShell(props: { children: ReactNode }) {
  return <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-16 pt-6">{props.children}</main>;
}

function GateCard(props: {
  gate: RoomGate | null;
  gateEnabled: boolean;
  busy: boolean;
  onRelease: () => void;
  onRegenerate: () => void;
  onStartNow: () => void;
}) {
  const { gate, gateEnabled, busy, onRelease, onRegenerate, onStartNow } = props;
  const badge = gateStatusLabel(gate);
  const tones: Record<string, string> = {
    idle: "border-line bg-white/60 text-muted",
    armed: "border-accent/40 bg-accent/10 text-accent",
    open: "border-warning/40 bg-warning/10 text-warning"
  };
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={18} />
          <h2 className="text-base font-semibold">Room start gate</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tones[badge.tone]}`}>{badge.label}</span>
      </div>
      {!gateEnabled ? (
        <p className="mt-3 text-sm text-muted">
          Room start codes are OFF for this contest — ask the admin to enable "Room start codes" in the console settings. Stats and alerts below still work.
        </p>
      ) : (
        <>
          {gate && gate.mode === "otp" && gate.otp ? (
            <p className="mt-4 text-center font-mono text-5xl font-bold tracking-[0.35em] text-ink">{gate.otp}</p>
          ) : null}
          {gate?.mode === "open" ? (
            <p className="mt-3 text-sm text-muted">
              Everyone in this room is admitted automatically — no code needed. Releasing a code re-arms the gate for late arrivals only.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {!gate || gate.mode === "open" || !gate.otp ? (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={onRelease}>
                <KeyRound size={16} /> Release room code
              </button>
            ) : (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={onRegenerate}>
                <RefreshCw size={16} /> Regenerate code
              </button>
            )}
            {gate?.mode !== "open" ? (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={onStartNow}>
                <DoorOpen size={16} /> Start now — allow all
              </button>
            ) : null}
          </div>
          {gate?.released_by ? (
            <p className="mt-3 text-xs text-muted">
              Code released by {gate.released_by}{gate.released_at ? ` at ${new Date(gate.released_at).toLocaleTimeString()}` : ""}.
            </p>
          ) : null}
          {gate?.opened_by ? (
            <p className="mt-1 text-xs text-muted">
              Room opened by {gate.opened_by}{gate.opened_at ? ` at ${new Date(gate.opened_at).toLocaleTimeString()}` : ""}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function StatTile(props: { label: string; value: number; tone?: "danger" | "warning" | "accent" }) {
  const tone = props.tone === "danger" ? "text-danger" : props.tone === "warning" ? "text-warning" : props.tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{props.label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{props.value}</p>
    </div>
  );
}

function statusBadge(row: InvigilatorSessionRow): { label: string; className: string } {
  if (row.status === "active" && row.stale) return { label: "Disconnected", className: "border-danger/40 bg-danger/10 text-danger" };
  if (row.status === "active") return { label: "Recording", className: "border-accent/40 bg-accent/10 text-accent" };
  if (row.status === "locked") return { label: "Locked", className: "border-danger/40 bg-danger/10 text-danger" };
  if (row.status === "pending_approval") return { label: "Waiting approval", className: "border-warning/40 bg-warning/10 text-warning" };
  if (row.status === "ended") return { label: "Finished", className: "border-line bg-white/60 text-muted" };
  return { label: row.status || "Unknown", className: "border-line bg-white/60 text-muted" };
}

function AlertRow(props: { alert: InvigilatorAlert }) {
  const { alert } = props;
  const tone = alert.severity === "critical"
    ? "border-danger/40 bg-danger/10 text-danger"
    : alert.severity === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : "border-line bg-white/60 text-muted";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white/60 px-3 py-2 text-sm">
      <AlertTriangle size={16} className={alert.severity === "critical" ? "text-danger" : "text-warning"} />
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{alert.severity}</span>
      <span className="font-medium text-ink">{alert.title}</span>
      <span className="text-muted">{alert.hackerrank_username}</span>
      <span className="ml-auto text-xs text-muted">{new Date(alert.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

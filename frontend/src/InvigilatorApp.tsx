// frontend/src/InvigilatorApp.tsx
// S3 — the room invigilator portal (/invigilator). Unlock mirrors the admin
// gate (client-side verify, then the typed password rides x-invigilator-password
// on every call; the backend also accepts the admin credential). NO signed-QR
// ID verification here — that is DEFERRED by design; ID checks stay manual.
// S-D (vision I1): /invigilator?contest={slug}&key={invigilator_key} — the
// per-contest token authenticates THAT contest only (verified server-side on
// the first call; no client hash exists for it). The typed global/admin
// password stays as the fallback, and every call is contest-scoped.
import { AlertTriangle, Bell, ChevronDown, ChevronUp, DoorOpen, KeyRound, RefreshCw, ShieldCheck, Unlock, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  adminPassword, adminPasswordHash,
  fetchInvigilatorOverview, fetchInvigilatorRoom, invigilatorExempt, invigilatorUnlock,
  invigilatorPassword, invigilatorPasswordHash,
  openRoom, releaseRoomCode, releaseUnlockCode, sha256Hex
} from "./api";
import { candidateIdOf } from "./identity";
import { gateStatusLabel } from "./invigilator/gateLogic";
import { portalCredential, portalLinkOf } from "./invigilator/portalLink";
import { alertExplanation, matchesStatusFilter } from "./invigilator/roomView";
import type { StatusFilter } from "./invigilator/roomView";
import type { EnforcementExemptions, InvigilatorAlert, InvigilatorRoomResponse, InvigilatorSessionRow, RoomGate } from "./types";

const POLL_INTERVAL_MS = 5000;
const savedKeyBase = "aerele-proctor-invigilator";
const UNASSIGNED_KEY = "_";
const UNASSIGNED_LABEL = "(no room set)";
const OTHER_CHOICE = "__other__";

type SavedIdentity = { name: string; room: string };

// S-D: the saved name/room are per contest — two parallel drives must not
// hand each other's room to the invigilator. Legacy keeps the historical key.
function savedKeyFor(contest: string): string {
  return contest ? `${savedKeyBase}::${contest}` : savedKeyBase;
}

function readSaved(contest: string): SavedIdentity {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(savedKeyFor(contest)) || "{}") as Partial<SavedIdentity>;
    return { name: String(parsed.name || ""), room: String(parsed.room || "") };
  } catch {
    return { name: "", room: "" };
  }
}

export function InvigilatorApp() {
  // S-D: the tokenized per-contest link (contest="" = the legacy portal).
  const link = useMemo(() => portalLinkOf(window.location.search), []);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  // A rejected link key (regenerated/stale) reveals the typed-password
  // fallback on the entry screen.
  const [keyRejected, setKeyRejected] = useState(false);
  const [name, setName] = useState(() => readSaved(link.contest).name);
  // The API value for the selected room ("_" = the unassigned pseudo-room).
  const [room, setRoom] = useState(() => readSaved(link.contest).room);
  const [roomChoice, setRoomChoice] = useState("");
  const [otherRoom, setOtherRoom] = useState("");
  const [rooms, setRooms] = useState<string[]>([]);
  const [hasUnassigned, setHasUnassigned] = useState(false);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [contestSlug, setContestSlug] = useState<string | null>(null);
  const [data, setData] = useState<InvigilatorRoomResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // F9.2: clicking a stat tile filters the student list; click again to clear.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(null);
  // F9.4: which room alert is expanded to its candidate-detail view.
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);

  const saveIdentity = (nextRoom: string) => {
    window.localStorage.setItem(savedKeyFor(link.contest), JSON.stringify({ name: name.trim(), room: nextRoom }));
  };

  // Unlock. Tokenized link: the key can only be verified SERVER-side (no
  // client hash exists for a per-contest secret), so the overview call is the
  // gate — a 401 reveals the typed-password fallback. Typed password: the
  // existing client-side checks (invigilator hash → plain → admin hash →
  // plain) run first, then the overview call scopes to the link's contest.
  const unlock = async () => {
    setError("");
    if (!name.trim()) {
      setError("Enter your name — code releases are recorded against it.");
      return;
    }
    const typed = passwordInput;
    const usingKey = Boolean(link.key) && !typed;
    if (!usingKey) {
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
    }
    const credential = portalCredential(link, typed);
    if (!usingKey) {
      // Typed-password path: client-verified — unlock immediately (today's
      // behavior); a failed overview only surfaces as an error, the room
      // poll keeps retrying.
      setPassword(credential);
      setUnlocked(true);
      setPasswordInput("");
      saveIdentity(room);
    }
    try {
      const overview = await fetchInvigilatorOverview(credential, link.contest || undefined);
      if (usingKey) {
        setPassword(credential);
        setUnlocked(true);
        saveIdentity(room);
      }
      setRooms(overview.rooms);
      setHasUnassigned(overview.has_unassigned);
      setGateEnabled(overview.room_gate_enabled);
      setContestSlug(overview.contest_slug);
    } catch (cause) {
      if (usingKey) {
        setKeyRejected(true);
        setError("This invigilator link is invalid or was regenerated. Ask the admin for the current link, or enter the invigilator password below.");
        return;
      }
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
    setStatusFilter(null);
    setExpandedAlertId(null);
    saveIdentity(next);
  };

  // Room dashboard poll: ONE GET per 5 s returns stats + students + gate +
  // alerts (mirrors the admin auto-poll; transient poll errors are swallowed).
  useEffect(() => {
    if (!unlocked || !room) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetchInvigilatorRoom(password, room, link.contest || undefined);
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
      const response = await releaseRoomCode(password, room, name.trim(), regenerate, link.contest || undefined);
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
      const response = await openRoom(password, room, name.trim(), link.contest || undefined);
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // F5.6 wave-2 fix: mint / re-display / regenerate the room's ENFORCEMENT
  // unlock code — its own namespace, available even when the start gate is off.
  const releaseUnlock = async (regenerate: boolean) => {
    if (regenerate && !window.confirm("Generate a NEW unlock code? The previous unlock code stops working.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await releaseUnlockCode(password, room, name.trim(), regenerate, link.contest || undefined);
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // F5.6 wave-2 fix: per-student release of an enforcement lock (the locked
  // screen tells the candidate the room proctor can "unlock you from their
  // console" — this is that console action). Admin locks never show the button.
  const unlockStudent = async (row: InvigilatorSessionRow) => {
    if (!window.confirm(`Unlock ${row.name || candidateIdOf(row)}? Their exam resumes immediately.`)) return;
    setError("");
    try {
      await invigilatorUnlock(password, room, candidateIdOf(row), link.contest || undefined);
      setData((current) => current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              candidateIdOf(session) === candidateIdOf(row)
                ? { ...session, status: "active", locked_reason: null }
                : session)
          }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // F5.5: toggle one enforcement exemption for ONE student (legit environment
  // problems — e.g. a flaky projector hook stealing focus). Applies to the
  // student's LIVE session within a heartbeat; the row updates optimistically
  // from the server's echoed exemptions.
  const toggleExemption = async (row: InvigilatorSessionRow, key: keyof EnforcementExemptions) => {
    setError("");
    try {
      const next = { [key]: !(row.enforcement_exemptions?.[key] === true) } as EnforcementExemptions;
      const response = await invigilatorExempt(password, room, candidateIdOf(row), next, link.contest || undefined);
      setData((current) => current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              candidateIdOf(session) === candidateIdOf(row)
                ? { ...session, enforcement_exemptions: response.enforcement_exemptions }
                : session)
          }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!unlocked) {
    // S-D: a tokenized link authenticates with the contest's key — only the
    // name is asked. The password field appears for the legacy portal, or as
    // the fallback once a link key is rejected (regenerated/stale).
    const tokenEntry = Boolean(link.key) && !keyRejected;
    return (
      <PortalShell>
        <section className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-6 shadow-subtle">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-accent" />
            <h1 className="text-xl font-semibold text-ink">Invigilator portal</h1>
          </div>
          {link.contest ? (
            <p className="mt-2 inline-flex rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              Contest: {link.contest}
            </p>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-muted">
            Room console: release the start code, start the room, watch who is recording, and read your room's alerts. ID checks are manual (no QR scanning).
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Your name</span>
              <input
                className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && tokenEntry) void unlock(); }}
              />
            </label>
            {!tokenEntry ? (
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
            ) : (
              <p className="text-xs leading-5 text-muted">
                This link carries your contest access key — no password needed.
              </p>
            )}
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
  // F9.2: the student list below honours the clicked stat tile.
  const sessions = data?.sessions ?? [];
  const visibleSessions = sessions.filter((row) => matchesStatusFilter(row, statusFilter));
  const toggleFilter = (filter: Exclude<StatusFilter, null>) =>
    setStatusFilter((current) => (current === filter ? null : filter));

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
              setStatusFilter(null);
              setExpandedAlertId(null);
              saveIdentity("");
            }
          }}
        >
          Change room
        </button>
      </header>

      {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {/* F9.1: the start-gate block only renders when the gate is actually in
          use — when it is off there is nothing for the invigilator to do here. */}
      {gateEnabled ? (
        <div className="mt-5">
          <GateCard
            gate={data?.gate ?? null}
            busy={busy}
            onRelease={() => void release(false)}
            onRegenerate={() => void release(true)}
            onStartNow={() => void startNow()}
          />
        </div>
      ) : null}

      {/* F5.6 wave-2 fix: the enforcement unlock card renders ALWAYS — locks
          happen whether or not the start gate is in use. */}
      <div className="mt-5">
        <UnlockCodeCard
          gate={data?.gate ?? null}
          busy={busy}
          onRelease={() => void releaseUnlock(false)}
          onRegenerate={() => void releaseUnlock(true)}
        />
      </div>

      {/* F9.2: each counter is a toggleable filter for the student list below. */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatTile label="Recording" value={stats?.live ?? 0} tone="accent"
          active={statusFilter === "recording"} onClick={() => toggleFilter("recording")} />
        <StatTile label="Disconnected" value={stats?.disconnected ?? 0} tone="danger"
          active={statusFilter === "disconnected"} onClick={() => toggleFilter("disconnected")} />
        <StatTile label="Locked" value={stats?.locked ?? 0} tone="danger"
          active={statusFilter === "locked"} onClick={() => toggleFilter("locked")} />
        <StatTile label="Waiting approval" value={stats?.pending_approval ?? 0} tone="warning"
          active={statusFilter === "pending_approval"} onClick={() => toggleFilter("pending_approval")} />
        <StatTile label="Finished" value={stats?.finished ?? 0}
          active={statusFilter === "finished"} onClick={() => toggleFilter("finished")} />
        <StatTile label="Started exam" value={stats?.started ?? 0} tone="accent"
          active={statusFilter === "started"} onClick={() => toggleFilter("started")} />
        <StatTile label="Total" value={stats?.total ?? 0} />
      </div>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Users size={18} />
          <h2 className="text-base font-semibold">Students in this room</h2>
          {/* F9.2: the active tile filter, with an inline clear affordance. */}
          {statusFilter ? (
            <button
              className="focus-ring ml-auto inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent"
              onClick={() => setStatusFilter(null)}
            >
              Showing {visibleSessions.length} of {sessions.length} — clear filter
            </button>
          ) : null}
        </div>
        {data && visibleSessions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Candidate ID</th>
                  <th className="py-2 pr-3">Roll no.</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Exam</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((row) => {
                  const badge = statusBadge(row);
                  return (
                    <tr key={candidateIdOf(row) || row.name} className="border-b border-line/60">
                      <td className="py-2 pr-3 font-medium text-ink">{row.name || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{candidateIdOf(row) || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{row.roll_number || "—"}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted">{row.exam_started_at ? "Started" : "Waiting"}</td>
                      <td className="py-2">
                        {/* F5.5: per-student enforcement exemptions for legit
                            environment problems. Disabled for ended sessions.
                            F5.6 wave-2: Unlock appears ONLY on enforcement
                            locks (admin locks stay admin-released). */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {row.status === "locked" && row.locked_reason === "fullscreen_enforcement" ? (
                            <button
                              className="focus-ring inline-flex items-center gap-1 rounded-full border border-danger/50 bg-danger/10 px-2.5 py-0.5 text-xs font-semibold text-danger"
                              title="Release this student's fullscreen-enforcement lock — their exam resumes immediately."
                              onClick={() => void unlockStudent(row)}
                            >
                              <Unlock size={12} /> Unlock
                            </button>
                          ) : null}
                          <ExemptionToggle
                            label="Fullscreen"
                            active={row.enforcement_exemptions?.fullscreen === true}
                            disabled={row.status === "ended"}
                            onToggle={() => void toggleExemption(row, "fullscreen")}
                          />
                          <ExemptionToggle
                            label="Switch-away"
                            active={row.enforcement_exemptions?.switch_away === true}
                            disabled={row.status === "ended"}
                            onToggle={() => void toggleExemption(row, "switch_away")}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">
            {!data ? "Loading…" : statusFilter && sessions.length
              ? "No students match this filter."
              : "No sessions in this room yet."}
          </p>
        )}
      </section>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex items-center gap-2">
          <Bell size={18} />
          <h2 className="text-base font-semibold">Room alerts</h2>
        </div>
        {data && data.alerts.length ? (
          <div className="space-y-2">
            {/* F9.4: click an alert to expand its candidate detail (joined from
                this room's session rows — no extra fields leave the server). */}
            {data.alerts.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                candidate={sessions.find((row) => candidateIdOf(row) === candidateIdOf(alert)) ?? null}
                expanded={expandedAlertId === alert.id}
                onToggle={() => setExpandedAlertId((current) => (current === alert.id ? null : alert.id))}
              />
            ))}
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

// F9.1: only rendered when the room gate is ENABLED — a disabled gate shows
// nothing at all (no explainer block) so invigilators are never distracted by
// machinery that is not in use.
function GateCard(props: {
  gate: RoomGate | null;
  busy: boolean;
  onRelease: () => void;
  onRegenerate: () => void;
  onStartNow: () => void;
}) {
  const { gate, busy, onRelease, onRegenerate, onStartNow } = props;
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
    </section>
  );
}

// F5.6 wave-2 fix: the ENFORCEMENT unlock code card. Renders ALWAYS (locks
// happen whether or not the start gate is in use). This code lives in its own
// namespace (gate.unlock_otp) — never the start OTP, which every candidate in
// an OTP-gated room personally typed — and is read to ONE locked student, not
// written on the board.
function UnlockCodeCard(props: {
  gate: RoomGate | null;
  busy: boolean;
  onRelease: () => void;
  onRegenerate: () => void;
}) {
  const { gate, busy, onRelease, onRegenerate } = props;
  const code = gate?.unlock_otp || "";
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Unlock size={18} />
          <h2 className="text-base font-semibold">Enforcement unlock code</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${
          code ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/60 text-muted"
        }`}>
          {code ? "Unlock code active" : "No unlock code yet"}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        When a student's exam locks itself (fullscreen rule), read them this code to release the lock — or use Unlock on their row below.
        This is NOT the start code: read it to the one locked student, don't write it on the board.
      </p>
      {code ? (
        <p className="mt-4 text-center font-mono text-5xl font-bold tracking-[0.35em] text-ink">{code}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {!code ? (
          <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={onRelease}>
            <KeyRound size={16} /> Release unlock code
          </button>
        ) : (
          <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={onRegenerate}>
            <RefreshCw size={16} /> Regenerate unlock code
          </button>
        )}
      </div>
      {gate?.unlock_released_by ? (
        <p className="mt-3 text-xs text-muted">
          Unlock code released by {gate.unlock_released_by}{gate.unlock_released_at ? ` at ${new Date(gate.unlock_released_at).toLocaleTimeString()}` : ""}.
        </p>
      ) : null}
    </section>
  );
}

// F5.5: one exemption pill — amber when ACTIVE (enforcement off = worth a
// glance), plain bordered when normal enforcement applies.
function ExemptionToggle(props: { label: string; active: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      className={`focus-ring rounded-full border px-2.5 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        props.active ? "border-warning/50 bg-warning/15 text-warning" : "border-line bg-white/60 text-muted"
      }`}
      title={props.active
        ? `${props.label} enforcement is EXEMPTED for this student — click to re-enable.`
        : `Exempt this student from ${props.label.toLowerCase()} enforcement (legit environment problem).`}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      {props.label}{props.active ? ": exempt" : ""}
    </button>
  );
}

// F9.2: a tile with onClick is a toggleable filter for the student list; the
// active tile is visually marked (accent border/fill + a "filtering" hint).
function StatTile(props: { label: string; value: number; tone?: "danger" | "warning" | "accent"; active?: boolean; onClick?: () => void }) {
  const tone = props.tone === "danger" ? "text-danger" : props.tone === "warning" ? "text-warning" : props.tone === "accent" ? "text-accent" : "text-ink";
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{props.label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{props.value}</p>
    </>
  );
  if (!props.onClick) {
    return <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">{body}</div>;
  }
  return (
    <button
      className={`focus-ring rounded-lg border p-4 text-left shadow-subtle ${
        props.active ? "border-accent bg-accent/10" : "border-line bg-panel"
      }`}
      title={props.active ? "Click to clear this filter" : `Show only: ${props.label.toLowerCase()}`}
      onClick={props.onClick}
    >
      {body}
      {props.active ? <p className="mt-1 text-[11px] font-semibold text-accent">filtering — click to clear</p> : null}
    </button>
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

// F9.4: a clickable alert row. Expanding shows candidate detail joined from the
// room's own session rows (name / roll number / roster id — identity data the
// dashboard already holds, never alert internals) plus the alert time and a
// plain-language explanation of what the alert type means.
function AlertRow(props: {
  alert: InvigilatorAlert;
  candidate: InvigilatorSessionRow | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { alert, candidate, expanded, onToggle } = props;
  const tone = alert.severity === "critical"
    ? "border-danger/40 bg-danger/10 text-danger"
    : alert.severity === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : "border-line bg-white/60 text-muted";
  return (
    <div className={`rounded-md border bg-white/60 text-sm ${expanded ? "border-accent/50" : "border-line"}`}>
      <button className="focus-ring flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left" onClick={onToggle}>
        <AlertTriangle size={16} className={alert.severity === "critical" ? "text-danger" : "text-warning"} />
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{alert.severity}</span>
        <span className="font-medium text-ink">{alert.title}</span>
        <span className="text-muted">{candidateIdOf(alert)}</span>
        <span className="ml-auto text-xs text-muted">{new Date(alert.timestamp).toLocaleTimeString()}</span>
        {expanded ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
      </button>
      {expanded ? (
        <div className="border-t border-line/60 px-3 py-3">
          <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">Candidate</dt>
              <dd className="font-medium text-ink">{candidate?.name || candidateIdOf(alert) || "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">Roll no.</dt>
              <dd className="text-ink">{candidate?.roll_number || "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">Roster ID</dt>
              <dd className="text-ink">{candidate?.roster_unique_id || "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">Time</dt>
              <dd className="text-ink">{new Date(alert.timestamp).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm leading-6 text-muted">{alertExplanation(alert.type)}</p>
        </div>
      ) : null}
    </div>
  );
}

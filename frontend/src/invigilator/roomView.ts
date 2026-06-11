// frontend/src/invigilator/roomView.ts — pure helpers for the invigilator room
// dashboard (F9.2 clickable status filters + F9.4 alert explanations).
// No React, no fetch — unit-tested with vitest.
import type { InvigilatorSessionRow } from "../types";

// F9.2: one filter per clickable stat tile. null = no filter (all rows). Each
// filter matches EXACTLY the rows its tile counts, so the filtered list length
// always agrees with the number on the tile the invigilator clicked.
export type StatusFilter =
  | "recording"
  | "disconnected"
  | "locked"
  | "pending_approval"
  | "finished"
  | "started"
  | null;

type FilterableRow = Pick<InvigilatorSessionRow, "status" | "stale" | "exam_started_at">;

export function matchesStatusFilter(row: FilterableRow, filter: StatusFilter): boolean {
  switch (filter) {
    case null:
      return true;
    case "recording":
      // stats.live counts ALL active rows (stale included), so so does this.
      return row.status === "active";
    case "disconnected":
      return row.status === "active" && row.stale === true;
    case "locked":
      return row.status === "locked";
    case "pending_approval":
      return row.status === "pending_approval";
    case "finished":
      return row.status === "ended";
    case "started":
      return Boolean(row.exam_started_at);
  }
}

// F9.4: plain-language explanation of each proctor alert type, written for an
// invigilator standing in the room (what happened + what to check). Unknown
// types get a generic line rather than echoing the raw type code.
const ALERT_EXPLANATIONS: Record<string, string> = {
  recording_stopped: "The screen recording on this student's machine stopped. Recording is mandatory — go to the student and check their exam screen.",
  screen_share_stopped: "The student stopped sharing their screen (or the share was interrupted). The exam cannot be proctored without it — check their machine.",
  recording_error: "The recorder on the student's machine hit an error and may not be capturing. Check their exam screen and ask them to follow the on-screen instructions.",
  fullscreen_enforcement: "The student left fullscreen more than the allowed limit, so the exam locked itself. Use Unlock on their row, or read them the room's unlock code (NOT the start code).",
  ip_changed: "The student's network address changed mid-exam — usually a Wi-Fi/hotspot switch, occasionally a device swap. Verify they are on the same machine.",
  tab_hidden: "The exam tab was hidden — the student switched to another tab or window. Check what is on their screen.",
  tab_away: "The exam was not visible on the student's screen for longer than the allowed time. Check what they were doing instead.",
  disconnected: "The student's machine stopped reporting in — the browser may be closed, asleep, or offline. Check whether they are still at their seat."
};

const GENERIC_ALERT_EXPLANATION =
  "Proctoring raised an alert for this student. Walk over and check their exam screen.";

export function alertExplanation(type: string): string {
  return ALERT_EXPLANATIONS[type] ?? GENERIC_ALERT_EXPLANATION;
}

// FIX-B3 #4: the portal entry blurb must not promise a step that won't appear.
// When the contest's room gate is ON the invigilator releases the start code /
// starts the room (the GateCard renders). When it's OFF no start-code panel
// exists, so the copy drops that clause and just describes the monitoring view.
export function portalEntryBlurb(gateEnabled: boolean): string {
  return gateEnabled
    ? "Room console: release the start code, start the room, watch who is recording, and read your room's alerts. ID checks are manual (no QR scanning)."
    : "Room console: watch who is recording and read your room's alerts. ID checks are manual (no QR scanning).";
}

// FIX-B3 #5: an invigilator room can show the SAME candidate twice — a stale
// session left behind plus a fresh re-join. With identical name/roll/id the two
// rows are indistinguishable. Disambiguate by the session START TIME so the
// invigilator can tell "which one is live". Returns "" when the row has no
// usable timestamp (nothing to show) or when the time is unparseable.
export function sessionStartedLabel(createdAt: string | null | undefined): string {
  const raw = String(createdAt ?? "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// FIX-B3 #5: should we even SHOW the per-row session-start disambiguator? Only
// when it adds signal — i.e. when more than one row shares the same candidate
// identity in the room. A unique candidate needs no extra timestamp clutter.
// Keyed by candidate id (falling back to name) so duplicates are detected the
// same way the React key is composed.
export function duplicateRowKeys<Row>(
  rows: Row[],
  keyOf: (row: Row) => string
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [key, count] of counts) if (count > 1) dupes.add(key);
  return dupes;
}

// FIX-B3 #6: distinguish an EMPTY alerts feed that is empty by configuration
// (no alert types are shared with invigilators for this contest) from one that
// is empty because nothing has fired yet. `alertsShared === false` means the
// admin opted no types in, so empty reads as intentional, not broken.
export function emptyAlertsHint(alertsShared: boolean): string {
  return alertsShared
    ? "No open alerts for this room."
    : "No alert types are shared with invigilators for this contest.";
}

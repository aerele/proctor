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
  fullscreen_enforcement: "The student left fullscreen more than the allowed limit, so the exam locked itself. They need the room code (or an admin) to continue.",
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

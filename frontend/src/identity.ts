// frontend/src/identity.ts — S-A identity helpers (F9 spec §5 stage S-A).
//
// The user-facing label became "Candidate ID" in S-A, but the WIRE field
// hackerrank_username is frozen until S-E (it is embedded in doc ids and GCS
// paths — F9 D1). These two helpers bridge that gap:
//   candidateIdOf        accept-both READ adapter for display sites
//   sessionStartPayload  dual-field WRITE body for /api/session/start

import type { StudentForm } from "./types";

// `unknown` fields so loosely-typed rows (e.g. Record<string, unknown> demo /
// review session docs) can pass through without per-site casts.
export type CandidateIdentitySource = {
  candidate_id?: unknown;
  hackerrank_username?: unknown;
};

// Display adapter: DTOs may deliver candidate_id (newer backends), the legacy
// hackerrank_username, or both — render whichever is present, preferring
// candidate_id. Returns "" when neither is a non-blank string.
export function candidateIdOf(row: CandidateIdentitySource | null | undefined): string {
  if (!row) return "";
  const preferred = typeof row.candidate_id === "string" ? row.candidate_id.trim() : "";
  if (preferred) return preferred;
  return typeof row.hackerrank_username === "string" ? row.hackerrank_username.trim() : "";
}

// /api/session/start body: send BOTH candidate_id and hackerrank_username with
// the SAME value, so the current backend (which only reads hackerrank_username)
// keeps working unchanged while newer backends can start reading candidate_id.
export function sessionStartPayload(
  form: StudentForm,
  existingSessionId?: string | null
): Record<string, unknown> {
  return {
    candidate_id: form.candidate_id,
    hackerrank_username: form.candidate_id,
    name: form.name,
    roll_number: form.roll_number,
    email: form.email,
    room: form.room,
    consent_accepted: form.consent_accepted,
    ...(form.roster_unique_id ? { roster_unique_id: form.roster_unique_id } : {}),
    ...(existingSessionId ? { session_id: existingSessionId } : {})
  };
}

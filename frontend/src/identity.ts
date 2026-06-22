// frontend/src/identity.ts — S-A identity helpers (F9 spec §5 stage S-A).
//
// The user-facing label became "Candidate ID" in S-A, but the WIRE field
// hackerrank_username is frozen until S-E (it is embedded in doc ids and GCS
// paths — F9 D1). These two helpers bridge that gap:
//   candidateIdOf        accept-both READ adapter for display sites
//   sessionStartPayload  dual-field WRITE body for /api/session/start

import type { SessionConsent, StudentForm } from "./types";
import { CONSENT_VERSION } from "./candidate/consentContent";

// G1 (v1.1 privacy & consent): assemble the structured consent record (design
// contract §1.2) from the four gate booleans on the form + the served
// consent_version + the remote/at-college context. PURE so it is unit-tested.
// `accepted_at` is injected (not Date.now() inside) so the test is deterministic.
export function buildSessionConsent(
  form: Pick<StudentForm, "consent_accepted" | "right_to_consent" | "viewed_terms" | "viewed_privacy">,
  opts: { consentVersion?: string | null; takeHome?: boolean; acceptedAt: string }
): SessionConsent {
  return {
    accepted: form.consent_accepted === true,
    right_to_consent: form.right_to_consent === true,
    viewed_terms: form.viewed_terms === true,
    viewed_privacy: form.viewed_privacy === true,
    consent_version: (opts.consentVersion || "").trim() || CONSENT_VERSION,
    accepted_at: opts.acceptedAt,
    context: opts.takeHome ? "remote_take_home" : "at_college"
  };
}

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
//
// G1 (v1.1): when a structured `consent` record is supplied it rides the body
// (design §2.1 — the server re-enforces the gate). The flat consent_accepted
// mirror is ALWAYS sent (denormalized, design §1.2) so the current backend's
// bare-boolean check keeps working during the transitional release.
export function sessionStartPayload(
  form: StudentForm,
  existingSessionId?: string | null,
  consent?: SessionConsent
): Record<string, unknown> {
  return {
    candidate_id: form.candidate_id,
    hackerrank_username: form.candidate_id,
    name: form.name,
    roll_number: form.roll_number,
    email: form.email,
    room: form.room,
    // Flat mirror — the consent CHOICE (consent.accepted when structured consent
    // is present, else the form flag) so a transitional backend never breaks.
    consent_accepted: consent ? consent.accepted : form.consent_accepted,
    ...(consent ? { consent } : {}),
    ...(form.roster_unique_id ? { roster_unique_id: form.roster_unique_id } : {}),
    ...(existingSessionId ? { session_id: existingSessionId } : {})
  };
}

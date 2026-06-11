// frontend/src/shell/candidateRouting.ts
//
// S-D candidate routing (vision C1 + §10.3) — PURE decisions for the candidate
// portal entry:
//
//   ?contest=<slug> pins the app to that contest (per-contest exam-config).
//   A PRESENT-but-bad param (unknown / not open) -> the access-code landing
//   page. An ABSENT param keeps TODAY'S legacy flow while the legacy settings
//   doc exists (bit-for-bit deployment guarantee) and shows the landing page
//   once it doesn't. Transient fetch failures NEVER land on the code page:
//   a pinned link degrades to a retry screen, a failed legacy probe fails
//   OPEN to the legacy flow.
//
// The fetch/DOM glue lives in App.tsx; everything here is vitest-tested.

export type CandidateRoute =
  | { kind: "legacy" }
  | { kind: "contest"; slug: string }
  /** Access-code landing. `notice` explains WHY when a bad link sent us here. */
  | { kind: "landing"; notice: string }
  /** Pinned link, transient config failure — render an inline retry, never the code box. */
  | { kind: "config_error"; slug: string };

/** The ?contest= value of a location.search string, trimmed ("" when absent). */
export function contestParamOf(search: string): string {
  return new URLSearchParams(search).get("contest")?.trim() ?? "";
}

/** The exam-config outcome for a PRESENT ?contest= param decides the route. */
export function routeForPinnedOutcome(
  slug: string,
  outcome: { ok: true } | { ok: false; status?: number; code?: string }
): CandidateRoute {
  if (outcome.ok) return { kind: "contest", slug };
  // The backend's two DEFINITIVE rejections (S-D contract): the link is wrong
  // or the contest is not open — both mean "type your test code instead".
  if (outcome.code === "unknown_contest" || outcome.status === 400) {
    return { kind: "landing", notice: "That test link is not recognized. Enter your test code instead." };
  }
  if (outcome.code === "contest_not_open" || outcome.status === 403) {
    return { kind: "landing", notice: "That test is not open right now. Enter your test code, or check with your invigilator." };
  }
  // Anything else (network, 5xx) is transient: the link may be perfectly
  // valid, so hold the candidate on a retry screen.
  return { kind: "config_error", slug };
}

/** With NO ?contest= param, the /api/candidate-route probe decides. */
export function routeForNoParam(
  outcome: { ok: true; legacy_configured: boolean } | { ok: false }
): CandidateRoute {
  // Probe failure fails OPEN to the legacy flow — today's deployment must
  // keep working even if the (new) routing endpoint is unreachable.
  if (!outcome.ok || outcome.legacy_configured) return { kind: "legacy" };
  return { kind: "landing", notice: "" };
}

// Mint alphabet parity with backend contests.mjs ACCESS_CODE_ALPHABET:
// A-Z plus the digits 2-9 (0 and 1 are never minted — 0/O, 1/I ambiguity).
const ACCESS_CODE_PATTERN = /^[A-Z2-9]{6}$/;

/** Uppercase, strip all whitespace, cap at the 6-char box length. */
export function normalizeAccessCodeInput(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "").slice(0, 6);
}

/** True when the (normalized) value is submittable. */
export function accessCodeReady(value: string): boolean {
  return ACCESS_CODE_PATTERN.test(value);
}

/** Human copy for a failed POST /api/access-code, keyed on the API error. */
export function landingErrorMessage(status?: number, code?: string): string {
  if (status === 429 || code === "rate_limited") {
    return "Too many attempts from this network. Wait a minute, then try again.";
  }
  if (status === 404 || code === "code_not_found") {
    return "That code was not recognized. Check it against the code your invigilator gave you and try again.";
  }
  if (status === 400 || code === "invalid_code") {
    return "Enter the full 6-character test code (letters and digits only).";
  }
  return "Could not check the code. Make sure you are online and try again.";
}

/**
 * Human copy for a failed POST /api/roster/lookup (the unique-id-confirm login),
 * keyed on the API error. The M3 rate limiter can 429 a shared-network burst, so
 * the candidate gets a plain wait-and-retry message (with the server's
 * retry_after_seconds when present) instead of the raw `rate_limited` string.
 * A 404 is a wrong/unknown id; anything else is a generic try-again.
 */
export function rosterLookupErrorMessage(
  status?: number,
  code?: string,
  retryAfterSeconds?: number
): string {
  if (status === 429 || code === "rate_limited") {
    const secs = Number(retryAfterSeconds);
    const wait = Number.isFinite(secs) && secs > 0
      ? `Wait ${secs} second${secs === 1 ? "" : "s"} and try again`
      : "Wait a minute and try again";
    return `Too many lookups from this network. ${wait}, or ask an invigilator for help.`;
  }
  if (status === 404 || code === "not_on_roster" || code === "roster_not_configured") {
    return "We could not find that ID on the student list. Check it and try again, or call an invigilator.";
  }
  return "Could not check that ID. Make sure you are online and try again.";
}

/** The pinned candidate URL a resolved access code redirects to. */
export function contestUrlFor(slug: string): string {
  return `/?contest=${encodeURIComponent(slug)}`;
}

// ---- pinned-contest form mode -------------------------------------------------
// Person contests have NO public roster-lookup endpoint by design (S-C: the
// server resolves identity at /api/session/start, 409 college_choices on
// genuine ambiguity) — so the pinned form forks here, never on a fetch.

export type CandidateFormMode = "legacy" | "person_roster" | "person_open";

export function candidateFormMode(
  pinned: { identity_mode?: string } | null | undefined,
  rosterRequired: boolean
): CandidateFormMode {
  if (!pinned || pinned.identity_mode !== "person") return "legacy";
  return rosterRequired ? "person_roster" : "person_open";
}

type CandidateFormFields = {
  candidate_id: string;
  name: string;
  roll_number: string;
  email: string;
  room: string;
  consent_accepted: boolean;
  roster_unique_id: string;
};

// Permissive email shape (F12 review gap): a non-space run, then @, then a
// non-space run, then a dot, then a non-space run. Deliberately lenient — it
// only catches obvious typos (missing @, missing domain dot), never tries to
// be RFC-complete. Mirrored server-side in handler.mjs (isValidEmailFormat).
const EMAIL_FORMAT = /^\S+@\S+\.\S+$/;

export function isCandidateEmailValid(email: string): boolean {
  return EMAIL_FORMAT.test(email.trim());
}

// What "Start proctoring" needs per mode. legacy = the shipped rule verbatim;
// person_roster = the roster supplies name/roll/email server-side, so only the
// typed id + room + consent gate the button; person_open = the backend's
// no-roster person contract (id + name + email required, roll optional).
export function candidateFormReady(
  mode: CandidateFormMode,
  form: CandidateFormFields,
  rosterRequired: boolean
): boolean {
  if (mode === "person_roster") {
    return Boolean(form.roster_unique_id.trim() && form.room.trim() && form.consent_accepted);
  }
  if (mode === "person_open") {
    return Boolean(
      form.candidate_id.trim() &&
      form.name.trim() &&
      isCandidateEmailValid(form.email) &&
      form.room.trim() &&
      form.consent_accepted
    );
  }
  return Boolean(
    (!rosterRequired || form.roster_unique_id) &&
    form.candidate_id.trim() &&
    form.name.trim() &&
    form.roll_number.trim() &&
    isCandidateEmailValid(form.email) &&
    form.room.trim() &&
    form.consent_accepted
  );
}

const SESSION_STORAGE_KEY = "aerele-proctor-session-id";

// Per-contest resume token: the legacy (unpinned) flow keeps the HISTORICAL
// bare key so already-deployed sessions survive this release; every pinned
// contest gets its own key so two browser tabs can run two contests without
// evicting each other's resume token.
export function sessionStorageKeyFor(slug: string): string {
  return slug ? `${SESSION_STORAGE_KEY}::${slug}` : SESSION_STORAGE_KEY;
}

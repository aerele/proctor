# S2 — Roster upload + unique-ID-confirm login + room dropdown (design)

**Status:** READY — night-run stretch item 2 (see `night-run/MORNING-NOTES.md` §Scope).
**Author:** Ram. **Date:** 2026-06-09.
**Parent design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` §6 + §8 ("Compulsory roster upload + unique-ID-confirm login", "Room number = pre-fed dropdown + Other").
**Plan:** `docs/superpowers/plans/2026-06-09-s2-roster-login.md`.

---

## 1. Vision

Today a candidate self-asserts everything at login (username, name, roll number, email, free-text room). S2 makes identity **roster-based**:

- The **admin uploads the student roster** (CSV/TSV with *flexible columns* — colleges send different headers) and designates the **unique-ID column** (roll number, register number, email, …), plus optional mappings of columns onto our known identity fields.
- The **candidate logs in by confirming identity**: enter the unique ID → the matched record appears → "Yes, this is me" → form pre-fills with roster data (roster-sourced fields locked) → consent → start.
- **Room becomes a pre-fed dropdown (+ "Other" free text)** from an admin-configured room list.
- **Compulsory (Karthi):** when a roster is configured, `/api/session/start` **requires a roster match, server-side** — the client gate is UX only. When no roster is configured, the legacy flow is unchanged.

## 2. Locked decisions

1. **One active roster, global** — mirrors the single `active` settings doc. Roster **meta** lives in `SETTINGS_COLLECTION` under doc id `roster_meta` (same pattern as `alert_settings`); roster **entries** live in a new `ROSTER_COLLECTION` (`proctor_roster`), one doc per student keyed by the sanitized **normalized unique ID** → O(1) keyed lookup at login (no scans, scales to a KEC-style 800-concurrent login burst).
2. **Versioned replace, no mass delete.** Each upload stamps a fresh `roster_version` (uuid); meta is written **last**. Lookup ignores any entry whose `roster_version` differs from the meta's current one, so stale entries from a previous upload are invisible without an expensive collection wipe, and a half-failed upload never becomes active.
3. **CSV parsed client-side** (admin browser) by our own small, unit-tested CSV/TSV parser (quoted cells, `""` escapes, BOM, comma/tab/semicolon auto-detect). The backend receives **structured JSON** `{columns, rows, unique_id_column, column_mapping}` — it never parses CSV. XLSX is out of scope (admins export CSV from Excel).
4. **Column mapping = required unique-ID column + optional identity fields** (`name`, `email`, `roll_number`, `hackerrank_username`, `room`), **auto-suggested** from header-name heuristics, admin can override each via dropdowns. Unmapped extra columns (phone numbers etc.) are stored with the entry but **never returned by any public endpoint**.
5. **Server-enforced identity override.** At `/api/session/start`, when a roster is configured: `roster_unique_id` is required and must match the active roster (else 403). Mapped identity fields (`name`, `email`, `roll_number`, `hackerrank_username`) are **overridden from the roster entry** — client-typed values are ignored for mapped fields, so a candidate can never start under an off-roster identity or edit a prefilled one. The session doc is stamped `roster_unique_id` + `roster_verified: true`.
6. **`hackerrank_username` remains the session key** (live-slot lock, storage prefix). Don't break the session model (parent-design guardrail §10). If the roster maps a username column it pre-fills + overrides; otherwise the candidate still types it.
7. **Rooms are admin-configured on the settings doc** (`rooms: string[]`, edited in the Settings gate section, comma/newline separated, `sanitizeRoom`-sanitized + case-insensitively deduped, max 50). Single source for the student dropdown now and the S3 invigilator portal / S6 attendance later. Roster `room` mapping only **pre-selects** the dropdown — the candidate picks where they actually sit; "Other" allows a free-text room (existing `sanitizeRoom` applies server-side).
8. **Public pre-session config endpoint** — the student form renders before any session exists, so a new **unauthenticated** `GET /api/exam-config` returns `{roster_required, unique_id_label, rooms}`. `unique_id_label` is the designated column's header (so the form says "Register Number" when that's what the college calls it). Client **fails open** to the legacy form if this fetch fails — safe because the roster gate is enforced server-side at start regardless.
9. **Lookup returns confirmation-safe fields only** (PII minimization, see §7): name, unique ID, roll number, room, hackerrank username, **masked** email. The raw email reaches the session doc only via the server-side override at start.

## 3. Data model

**Settings doc `active`** (existing, `SETTINGS_COLLECTION`) — gains:
```
rooms: string[]            // sanitized, deduped, ≤ 50 labels
```

**Roster meta doc** (`SETTINGS_COLLECTION` / `roster_meta`):
```
configured: boolean         // false after "clear roster"
version: string             // uuid; entries must match to be visible
unique_id_column: string    // e.g. "Roll No" — also the student-facing label
column_mapping: { name?, email?, roll_number?, hackerrank_username?, room? }  // field -> column header
columns: string[]           // all headers, order preserved
count: number               // accepted rows
updated_at: ISO string
```

**Roster entry docs** (`ROSTER_COLLECTION`, doc id = `rosterEntryId(normalizeUniqueId(unique_id))`):
```
unique_id: string           // display form, as uploaded
unique_id_norm: string      // trim + lowercase + strip ALL whitespace
roster_version: string
fields: { <column header>: <trimmed cell ≤ 200 chars>, ... }
created_at: ISO string
```
`normalizeUniqueId` strips internal whitespace too ("21 CS 001" ≡ "21CS001" — colleges format roll numbers inconsistently). `rosterEntryId` makes the norm Firestore-doc-id-safe (`[a-z0-9@._-]`, no `/`, never empty/all-dots). Sanitizer collisions and duplicate IDs are detected **at upload** (the upload sees all rows) and reported as `skipped` rows.

**Session doc** (existing) — gains:
```
roster_unique_id: string    // "" when no roster
roster_verified: boolean
```

**Limits:** ≤ 5000 rows/upload (mirrors `REVIEW_ROSTER_LIMIT`), ≤ 30 columns, cell ≤ 200 chars, ≤ 50 rooms. Entry writes use the existing `mapWithConcurrency` (bounded fan-out, like `adminSessions`).

## 4. API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/admin/roster` | admin password | Upload `{unique_id_column, columns, column_mapping, rows}` → `{ok, configured, count, skipped:[{row, reason}]}`. Or `{clear: true}` → roster off. |
| GET | `/api/admin/roster` | admin password | Meta summary only (`configured, count, unique_id_column, column_mapping, columns, updated_at`) — never the rows. |
| GET | `/api/exam-config` | none (public) | `{roster_required, unique_id_label, rooms}` for the pre-session student form. |
| POST | `/api/roster/lookup` | none (public) | `{unique_id}` → `{found, unique_id, name, roll_number, room, hackerrank_username, email_masked}` or 404 (`not_on_roster` / `roster_not_configured`). |
| POST | `/api/session/start` | (existing) | Extended: roster gate + server-side identity override (§2.5). Errors: 403 `roster_id_required`, 403 `not_on_roster`. |
| GET/POST | `/api/admin/settings` | admin password | Extended: persists + returns `rooms` (older admin UIs that don't send `rooms` preserve the stored list). |

`skipped` reasons: `empty_unique_id`, `duplicate_unique_id` (post-normalization, includes sanitizer collisions). Upload 400s when: `unique_id_column` not in `columns`, empty/oversized rows or columns, or **every** row was skipped.

## 5. UI behavior

**Admin → Settings tab:**
- Gate section gains a **Rooms** field (comma-separated; reuses `parseRosterInput` for split/trim/dedupe; saved with the gate).
- New **Candidate roster** section (`CandidateRosterSection`, self-contained, below the gate): status line ("Roster active: N students, ID column X, updated …" / "No roster — login is open"), file picker (`.csv/.tsv/.txt`) → client-side parse → preview of the first 5 rows → **Unique-ID column** select (required) + five optional mapping selects (pre-suggested from headers) → "Upload roster (N students)" → result message incl. skipped-row summary → **Clear roster** button when configured. Degrades to "not deployed yet" on backend 404 (same pattern as `ReviewRosterSection`).

**Student page (form stage):**
- On mount, fetch `/api/exam-config` (fail-open).
- **Roster configured:** "Step 1 — confirm your identity" panel replaces the details form: unique-ID input (labeled with `unique_id_label`) + **Find me** → match card ("Is this you?" with name/roll/masked-email/username/room) → **Yes, this is me** (pre-fills + locks roster-sourced fields, stores `roster_unique_id` in the form) or **No — search again**. After confirming, a slim "Identity confirmed: \<id\>" strip with **Not you? Re-enter ID** (full reset) stays above the details form. Roster-sourced fields render `disabled`; fields the roster doesn't cover stay editable. Consent + Start appear only after the identity step.
- **Room:** dropdown of configured rooms + "Other…" (reveals free-text input); plain text field when no rooms configured (legacy). Roster `room` pre-selects when present.
- `startSession` sends `roster_unique_id`; start `403 roster_id_required / not_on_roster` shows a human message pointing back to the identity step.
- **No roster:** form identical to today except the room dropdown (when rooms configured).
- Demo mode (`VITE_DEMO_MODE=true`): roster stored in localStorage (`aerele-proctor-demo-roster`); lookup/upload/clear/exam-config/start-gate all mirrored so the whole flow runs offline for browser-integration testing.

## 6. Error handling

- **Lookup 404** → "We could not find that ID on the student list. Check it and try again, or call an invigilator." (Same message for `roster_not_configured` — a race where admin clears mid-login resolves at start anyway.)
- **Start 403 roster codes** → human message with "re-enter ID" guidance; machine codes preserved in `error` for tests/automation (matches the `session_locked` pattern).
- **Upload:** per-row skips reported (never silently dropped); ragged CSV rows padded + surfaced as parse warnings client-side; empty file / no valid rows → clear inline error; backend 404 → "not deployed yet" degrade.
- **Replay/resume:** the idempotent start-replay path re-runs the roster gate (client retains `roster_unique_id` in form state); `/api/session/resume` is untouched (session token is the credential).
- **exam-config fetch failure** → legacy form; server still enforces the gate at start (fail-open is safe, fail-closed would block logins on a blip).

## 7. Security & PII

- Roster gate enforced **server-side at start**; all client gating is UX.
- Public lookup returns the **minimum confirmation set**; email is masked (`as**@example.com`); unmapped columns never leave the server via public routes. Raw roster rows are readable only via the admin-authed meta (which excludes rows entirely).
- **Accepted limitation (flag in PII audit):** `/api/roster/lookup` is unauthenticated and ID-enumerable by design (the candidate must self-serve pre-session; campus-scale threat). Mitigations: minimal/masked response, no bulk endpoint, normalized IDs are non-sequentially guessable in practice (roll numbers ARE guessable — hence masking). Rate limiting deferred (Cloud Run per-instance memory makes naive limiters weak).
- Admin upload is gated by the existing `x-admin-password`; roster rows transit HTTPS once and live in Firestore like existing session PII.

## 8. Testing

- **Backend** (`backend/test/roster.test.mjs`, conventions: env-before-import + `?roster` cache-buster, inline fakes, `__setClientsForTest`): upload happy path + skips + 401 + validation; meta/clear; settings rooms sanitize/dedupe; exam-config shapes; lookup safe-fields/masking/normalization/staleness/404s; start gate (missing ID, wrong ID, identity override, username-mapping override, no-roster regression).
- **Frontend pure** (`frontend/src/roster/parseRoster.test.ts`, vitest): delimiter detection, quoted-cell parsing, BOM, ragged rows, header dedupe, mapping heuristics, unique-ID preference.
- **Browser integration** (demo mode via the :9222 MCP): upload sample CSV → student identity gate → confirm → prefilled/locked fields → room dropdown + Other → wrong-ID error → clear roster → legacy form returns.

## 9. Out of scope (S2)

- XLSX parsing; multi-roster / per-contest rosters; roster row editing UI; roster pagination/search in admin.
- Attendance stats from the roster (item S6 — enabled by `roster_unique_id` on sessions + the entries collection).
- Room OTP, invigilator portal, fullscreen-first onboarding (items S1/S3); signed-QR ID check (DEFERRED, parent §10).
- Lookup rate limiting / CAPTCHA (accepted limitation, §7).
- Changing the session key away from `hackerrank_username` (future own-editor identity work).

## 10. Interactions with parallel night-run items

- **Do not touch** `frontend/src/coding/*` (Slice 1, building in parallel).
- S1-stretch (fullscreen-first onboarding) also edits `StudentApp`'s form area — execute S2's Task 7 **after** S1-stretch lands if both run tonight, and re-anchor edits by landmark if lines moved.
- S3 (invigilator portal) and S6 (attendance) consume `rooms` and `roster_unique_id`/entries respectively — both are additive on this model.

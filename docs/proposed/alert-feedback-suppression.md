# ALERT-1 — Candidate alert feedback + per-user/test alert suppression

**Status:** Proposed (code-grounded design). Roadmap item **ALERT-1** (v1.1).
**Source intent:** owner request, 2026-06-23 — "on an alert shown to the candidate,
add a SECOND button (Option A: I understand / I won't repeat; Option B: this alert
is wrong / unfair / a bug). Option B raises a NEW dispute alert on the admin
dashboard. The admin can SUPPRESS that alert for that user for that test, using
the SAME suppression machinery as the existing fullscreen/anomaly exemptions. It
also feeds platform improvement."
**Author:** the agent, 2026-06-23.

> One-line scope: the candidate's hard-block alert overlay gains a second
> ("dispute") button that posts a candidate-authed self-report; the server raises
> a `dispute_raised` proctor alert that lands on the admin AlertsConsole; the
> admin clicks **Suppress** on any alert to add a `(username_norm, test,
> alert_type)` tuple to a shared **alert-suppression** list — the same kind of
> raise-time check the existing `enforcement_exemptions` already perform, just
> keyed by alert-type and scoped per-test instead of per-session-key. Suppressed
> pairs are skipped at raise time thereafter and are visible/removable in a shared
> admin list.

---

## 0. Why this is a thin extension, not a new subsystem

Three pieces of machinery already exist and ALERT-1 reuses each verbatim or as a
near-clone:

1. **A candidate-authed self-report route that raises a proctor alert.**
   `POST /api/session/enforcement-violation`
   (`backend/src/routes/sessionGates.mjs:129-156`) already takes the unguessable
   session token (`requireWritableSession`), checks a server-side exemption, and
   calls `upsertProctorAlert(session, …)` to land an alert on the admin console.
   The dispute button is the SAME shape of route — a candidate self-report that
   raises one idempotent alert — so we add a sibling handler in the same factory,
   not a new auth surface.

2. **A raise-time suppression check.** `raiseSwitchAwayAlerts`
   (`proctorAlerts.mjs:309-310`) and `reconcileFullscreenEnforcement`
   (`enforcement.mjs:131-132`) both short-circuit on
   `sanitizeExemptions(session.enforcement_exemptions).<key> === true` BEFORE
   raising/locking. ALERT-1 adds ONE more guard of the same form inside
   `upsertProctorAlert` — the single chokepoint every sure-shot, switch-away and
   enforcement alert already funnels through (`proctorAlerts.mjs:350-383`) — so
   suppression is enforced once, for every alert type, with no per-call-site
   wiring.

3. **An admin "exempt" action + a sanitizer + a per-type settings store.** The
   `exempt` session action (`adminSessions.mjs:801-808`) merges a sanitized
   boolean map onto the session doc; `sanitizeExemptions`
   (`enforcement.mjs:46-53`) allow-lists keys; the alert-settings doc
   (`mergeAlertSettings`, `proctorAlerts.mjs:153-176`) is a single Firestore doc
   the admin reads/writes for per-alert-type config. ALERT-1's suppression list is
   the same pattern: an admin POST writes a sanitized, allow-listed entry; a
   single read (cached like `getAlertSettings`) feeds the raise-time guard.

The new persistent state is exactly **one new Firestore doc** (the shared
suppression list) plus **one new alert type** (`dispute_raised`) and **one new
candidate route** (`/api/session/dispute-alert`). No new collection, no new
auth tier, no new poller.

---

## 1. The relationship to `enforcement_exemptions` (and why we don't just reuse it)

`enforcement_exemptions` is **per-session** (`{fullscreen, switch_away}` booleans
stored on the SESSION doc, `enforcement.mjs:41`). It suppresses two specific
*enforcement* behaviours, keyed to one session document.

The brief asks for suppression keyed by **(user, test, alert-type)** — i.e. it
must:

- survive a session restart (a candidate who re-enters the exam gets a NEW session
  doc; a per-session flag would not carry over), and
- target an arbitrary **alert type** (e.g. `tab_hidden`, `ip_changed`), not just
  the two enforcement knobs.

So `enforcement_exemptions` is the **pattern** to copy, not the **field** to
extend. ALERT-1 introduces a sibling concept — **alert suppressions** — that is
the per-(user, test, type) generalization of the per-session exemption:

| | `enforcement_exemptions` (existing) | `alert_suppressions` (ALERT-1) |
|---|---|---|
| Scope key | one session doc | `(username_norm, contest_slug, alert_type)` |
| Stored on | the session doc field | one shared Firestore doc `alert_suppressions::<id>` |
| Allow-list | `sanitizeExemptions` (2 keys) | `sanitizeSuppressionEntry` (type ∈ catalog) |
| Set by | `exempt` session action | `suppress` alert action (new) |
| Checked at | `raiseSwitchAwayAlerts`, fullscreen reconcile | `upsertProctorAlert` (the shared chokepoint) |
| Survives restart | no (per session) | yes (per user+test) |

The two coexist. `enforcement_exemptions.switch_away` continues to gate the
*locking/enforcement* dimension of switch-away; an `alert_suppressions` entry for
`tab_away` gates the *alerting* dimension. (See §6 for how they layer.)

---

## 2. Data model — the shared suppression list

### 2.1 Storage

ONE Firestore doc, mirroring the alert-settings doc's single-doc pattern
(`settingsCollection`.doc(`alertSettingsId`), `proctorAlerts.mjs:146`). New
constants threaded through `handler.mjs` ctx by value exactly like
`alertSettingsId`:

```
ALERT_SUPPRESSIONS_DOC_ID = "alert_suppressions"   // in settingsCollection
```

Doc shape (additive, no schema migration — absent doc = empty list):

```jsonc
{
  "entries": [
    {
      "username_norm": "alice",            // the alert's username_norm (the join key)
      "contest_slug": "kpr-round-2",       // "" / "_" for an unscoped/orphaned alert
      "alert_type": "tab_away",            // ∈ SUPPRESSIBLE_ALERT_TYPES catalog
      "candidate_id": "alice",             // display label, for the admin list only
      "reason": "candidate disputed — VPN flagged as IP change",  // free text, capped
      "created_by": "admin",               // who suppressed (audit)
      "created_at": "2026-06-23T12:00:00.000Z",
      "source_alert_id": "proctor:dispute_raised:alice:kpr-round-2:2026-06-23"  // optional provenance
    }
  ],
  "updated_at": "2026-06-23T12:00:00.000Z"
}
```

**Why a single doc, not a subcollection.** The raise-time guard runs on the
hot path (`upsertProctorAlert` fires on every heartbeat/events batch). A single
doc rides the SAME TTL cache already built for alert-settings
(`alertSettingsCache`, `proctorAlerts.mjs:142-149`) — one cached read per request,
invalidated on write. A subcollection query per raise would be a per-heartbeat
Firestore read storm (the exact fan-out `adminSessions` warns about,
`adminSessions.mjs:142-147`). The list is bounded by `SUPPRESSIONS_MAX` (default
2000, same order as `ALERTS_QUERY_LIMIT`); a contest at scale suppresses a handful
of types for a handful of disputing candidates, so the list stays small.

### 2.2 The suppressible-type catalog + sanitizer (the `sanitizeExemptions` analogue)

In `proctorAlerts.mjs`, next to `DEFAULT_PROCTOR_ALERT_SETTINGS`:

```js
// ALERT-1: alert types an admin may suppress per (user, test). This is the
// alerting catalog (the keys of DEFAULT_PROCTOR_ALERT_SETTINGS) PLUS the new
// dispute_raised type — an admin can suppress a noisy dispute too. fullscreen_
// enforcement is suppressible for ALERTING only; it never gates the LOCK (the
// lock is policy via enforcement_mode, exactly as the F5.3 comment notes,
// proctorAlerts.mjs:114-116) — see §6.
const SUPPRESSIBLE_ALERT_TYPES = [
  ...Object.keys(DEFAULT_PROCTOR_ALERT_SETTINGS), // recording_stopped … disconnected, fullscreen_enforcement
  "dispute_raised"
];

// The sanitizeExemptions analogue (enforcement.mjs:46-53): allow-list every
// field, coerce/clamp, drop anything unknown so an admin payload can never
// stash arbitrary data or suppress an unknown type.
function sanitizeSuppressionEntry(input, { createdBy, now }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const alert_type = String(input.alert_type || "");
  if (!SUPPRESSIBLE_ALERT_TYPES.includes(alert_type)) return null;
  const username_norm = normalizeUsername(String(input.username_norm || input.candidate_id || ""));
  if (!username_norm || username_norm === "_") return null;
  return {
    username_norm,
    contest_slug: input.contest_slug ? String(input.contest_slug) : "",
    alert_type,
    candidate_id: input.candidate_id ? String(input.candidate_id).slice(0, 200) : username_norm,
    reason: input.reason ? String(input.reason).slice(0, 500) : "",
    created_by: String(createdBy || "admin").slice(0, 200),
    created_at: now,
    ...(input.source_alert_id ? { source_alert_id: String(input.source_alert_id).slice(0, 300) } : {})
  };
}
```

`username_norm` is normalized with the SAME `normalizeUsername` the alerts and
sessions already key on (`proctorAlerts.mjs:424-425`, `adminSessions.mjs:124`), so
the suppression key joins cleanly to both the alert's `username_norm` and the
admin console's `normalizeJoinUsername`.

### 2.3 The suppression-key match function (the chokepoint predicate)

```js
// True when (this user, this test, this alert type) is on the suppression list.
// contest_slug match is EXACT but treats "" and "_" as the same unscoped bucket
// (upsertProctorAlert stores "_" for an orphaned session, proctorAlerts.mjs:352).
function isAlertSuppressed(suppressions, { usernameNorm, contestSlug, type }) {
  const slug = contestSlug && contestSlug !== "_" ? contestSlug : "";
  return suppressions.some((e) =>
    e.username_norm === usernameNorm &&
    e.alert_type === type &&
    (e.contest_slug || "") === slug
  );
}
```

---

## 3. Backend — raise-time suppression at the single chokepoint

`upsertProctorAlert(session, {type, …})` (`proctorAlerts.mjs:350`) is the ONE
function every internally-raised alert flows through: sure-shots
(`raiseSureShotAlertsFromEvents` → `upsertProctorAlert`, `:290`), switch-away
(`:320`), fullscreen enforcement (`enforcement.mjs:87`), and the new dispute
alert (§4). Adding the guard here means **one edit suppresses every type** with no
per-site wiring — the same single-source discipline the file's header insists on
(`proctorAlerts.mjs:5-11`).

```js
async function upsertProctorAlert(session, { type, severity, timestamp, title, detail, dedupe, data }) {
  const usernameNorm = session.username_norm;
  const contestSlug = session.contest_slug || "_";

  // ALERT-1: per-(user, test, type) suppression. Read through the same TTL cache
  // as getAlertSettings (one cached read/request; the suppress/unsuppress writes
  // invalidate it). dispute_raised is NEVER suppressed at raise time even if a
  // stale entry exists — a candidate must always be able to dispute (see §4.3).
  if (type !== "dispute_raised") {
    const suppressions = await getAlertSuppressions();          // cached
    if (isAlertSuppressed(suppressions, { usernameNorm, contestSlug, type })) {
      return null; // suppressed: no alert doc written, caller treats null as "nothing raised"
    }
  }
  // … unchanged from here (id, item, alertRef(id).set(item, {merge:true})) …
}
```

**Caller-null contract.** Every current caller already ignores the return value
except the dispute route (§4), which checks it. `raiseSureShotAlertsFromEvents`
and `raiseSwitchAwayAlerts` `await` without using the result, so returning `null`
on a suppressed type is a safe no-op. Confirmed against all four call sites
(`proctorAlerts.mjs:290`, `:320`; `enforcement.mjs:87`; `sessionGates.mjs:151`
goes through `applyEnforcementViolation`, not directly — see §6).

**Evidence is never suppressed.** Suppression hides the ALERT only. The raw
events that *would have* produced it still land in evidence storage via
`recordEvents` (`sessionTelemetry.mjs:171-207`) exactly as the switch_away
exemption comment already documents (`proctorAlerts.mjs:307-308`). Suppression is
a triage/feedback control, not an evidence-deletion control — this is load-bearing
for the "feeds platform improvement" intent: the underlying signal is retained for
analysis even when the alert is hushed.

### 3.1 The suppression read + cache

A sibling of `getAlertSettings` (`proctorAlerts.mjs:137-151`):

```js
const ALERT_SUPPRESSIONS_CACHE_KEY = "proctor_alert_suppressions";

async function getAlertSuppressions() {
  if (alertSettingsCache) {                       // reuse the SAME cache instance
    const hit = alertSettingsCache.get(ALERT_SUPPRESSIONS_CACHE_KEY);
    if (hit !== undefined) return hit;
  }
  const doc = await getFirestore().collection(settingsCollection).doc(alertSuppressionsDocId).get();
  const entries = doc.exists && Array.isArray(doc.data()?.entries) ? doc.data().entries : [];
  if (alertSettingsCache) alertSettingsCache.set(ALERT_SUPPRESSIONS_CACHE_KEY, entries);
  return entries;
}
```

Reusing the existing `alertSettingsCache` (a TTL map already wired through ctx,
`proctorAlerts.mjs:61-65`, `handler.mjs:456`) means no new cache plumbing; the
admin write path calls `invalidateAlertSettingsCache()` which must be widened to
clear BOTH keys (or we add an `invalidateAlertSuppressionsCache` twin — trivial,
`handler.mjs:270` is the hook site).

---

## 4. Backend — the candidate dispute route + the `dispute_raised` alert type

### 4.1 New alert type

Add to the catalog so it normalizes, displays, and is configurable like any other:

- `proctorAlerts.mjs`: add `dispute_raised: { enabled: true, severity: "info",
  show_to_invigilator: false }` to `DEFAULT_PROCTOR_ALERT_SETTINGS`
  (`:110-122`). Severity `info` — a dispute is a candidate-flag for admin review,
  not a critical proctoring violation. It rides `mergeAlertSettings`
  (`:153-176`) for free, so an admin can disable the *type* globally if a contest
  is being spammed (distinct from per-user suppression).
- `types.ts`: extend the Alert `type` doc-comment union (`types.ts:584`) and the
  `ProctorAlertTypeConfig` map to include `dispute_raised`.

### 4.2 New candidate route — sibling of `sessionEnforcementViolation`

In `sessionGates.mjs` (same factory, same ctx, same auth model — the unguessable
session token via `requireWritableSession`):

```js
// POST /api/session/dispute-alert — the candidate clicked "this alert is not
// correct" on an alert overlay. Auth = the session token (like /api/events).
// Raises ONE info-severity dispute_raised alert onto the admin console; it is
// idempotent per (user, contest, day, disputed-type) so a double-click collapses.
// disputed_type is the alert the candidate is disputing (e.g. "tab_away"); it is
// ECHOED into data for the admin's one-click Suppress, but never trusted as
// anything but a label.
async function sessionDisputeAlert(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = requireWritableSession(await getSession(String(body.session_id)));
  const disputedType = String(body.disputed_type || "").slice(0, 64);
  const note = body.note ? String(body.note).slice(0, 500) : "";
  const alertSettings = await getAlertSettings();
  const cfg = alertTypeConfig(alertSettings, "dispute_raised", "info");
  if (!cfg.enabled) return { ok: true, raised: false };   // type disabled globally
  const raised = await upsertProctorAlert(session, {
    type: "dispute_raised",
    severity: cfg.severity,
    timestamp: new Date().toISOString(),
    title: "Candidate disputes an alert",
    detail: disputedType ? `Disputed: ${disputedType}${note ? ` — ${note}` : ""}` : (note || "Candidate flagged an alert as incorrect"),
    dedupe: `${disputedType || "any"}:${new Date().toISOString().slice(0, 10)}`, // per type per day
    data: { disputed_type: disputedType, note }
  });
  return { ok: true, raised: Boolean(raised) };
}
```

Dispatch line (next to `:1381`, byte-identical style):

```js
if (req.method === "POST" && path === "/api/session/dispute-alert") return send(res, 200, await sessionDisputeAlert(req));
```

`alertTypeConfig` is already in the `sessionGates` ctx import set's sibling
domains; if not yet threaded, add it by reference like `getAlertSettings`
(`sessionGates.mjs:60`). The route requires `upsertProctorAlert` and
`alertTypeConfig` in ctx — both already returned by `makeProctorAlerts`
(`proctorAlerts.mjs:484, 502`).

### 4.3 Why `dispute_raised` is itself never suppressed at raise time

The §3 guard skips suppression for `type === "dispute_raised"`. Rationale: the
dispute channel must stay open even if an admin (or a buggy bulk-suppress) put
`dispute_raised` on the list — otherwise a candidate could be silently denied the
ability to flag a genuine mistake. An admin who finds a candidate spamming
disputes uses the GLOBAL type toggle (`enabled:false` via alert-settings, §4.1) or
archives the noise — both already exist. (The per-day dedupe already collapses
double-clicks, so the spam surface is one alert per type per day per candidate.)

---

## 5. Frontend — the candidate two-button UI + copy

### 5.1 Which surface gets the second button

The candidate-visible "alert shown to the candidate" is the hard-block overlay
rendered by `EnforcementOverlay` (`frontend/src/shell/EnforcementOverlay.tsx`,
mounted in `StudentApp.tsx:591-605`) and the `AnomalyPanel` red bar
(`AnomalyPanel.tsx`). These are the moments a candidate is actively told "you did
something wrong." The dispute button goes on **both**, but the primary target is
`EnforcementOverlay` (the full takeover) because that is the most consequential
alert (it can lock the exam).

Both overlays already have exactly one primary action (re-enter fullscreen / "I
have fixed this"). ALERT-1 adds:

- **Option A — "I understand — I won't do this again"** (the existing comply
  path, relabelled / made explicit). This is the *acknowledge* action: it simply
  proceeds with the existing recovery (re-enter fullscreen + ack), no new network
  call. Copy frames it as accepting the flag.
- **Option B — "This alert looks wrong — report a problem"** (NEW). A secondary,
  visually-quieter button (outline, not the red primary) that opens a small
  inline confirm with the unambiguous copy below, then posts
  `POST /api/session/dispute-alert` with `disputed_type` = the current violation's
  alert type (`tab_away` / `fullscreen_enforcement` / etc., derivable from
  `enforcement.violation` / the anomaly reason).

### 5.2 Copy (Option B must NOT read as a get-out-of-jail button)

The button label and confirm copy are deliberately framed so an honest candidate
who simply doesn't want the flag will NOT press it, while a candidate hitting a
genuine software fault will:

- **Button label:** `Report a problem with this alert`
  (NOT "dispute" / "I disagree" / "this is unfair" as the primary label — those
  invite reflexive pressing).
- **Confirm panel heading:** `Only report a genuine technical problem`
- **Confirm body:**
  > Use this only if you believe this alert is a **software mistake** — for
  > example the app flagged you while you did nothing wrong, a button didn't work,
  > or the screen behaved incorrectly.
  >
  > This is **not** a way to dismiss a warning you caused. Your proctor will see
  > this report alongside the recording of what actually happened, and normal exam
  > rules still apply. Misuse may itself be flagged.
- **Optional one-line note field** (`note`, capped 500 chars) so the candidate can
  say what went wrong — fed into the dispute alert's `detail`/`data` for the admin.
- **On submit:** a calm toast — "Reported. Your proctor will review this." The
  overlay's recovery requirement is UNCHANGED (disputing does not unlock or bypass
  anything; if it was a lock, the candidate still needs the proctor's unlock code,
  `sessionGates.mjs:171`). This is critical: Option B raises a flag for humans, it
  never self-serves a release.

### 5.3 Wiring

- `api.ts`: add `reportAlertDispute(sessionId, disputedType, note)` — a clone of
  `reportEnforcementViolation` (`api.ts:4851-4873`) hitting
  `/api/session/dispute-alert`, with a demo-mode branch that no-ops (returns
  `{ok:true, raised:true}`), matching the demo discipline of every other client
  fn.
- `EnforcementOverlay` / `AnomalyPanel`: add the Option-A relabel + the Option-B
  secondary button + the confirm sub-panel as a local-state disclosure (no new
  global state). Props gain `onReportDispute(disputedType, note)` threaded from
  `StudentApp.tsx` (which holds the session id and the current violation type).
- A11y: the dispute confirm is a `role="dialog"` nested inside the existing
  `role="alertdialog"`, focus moves into the note field on open, ESC/Cancel closes
  it without sending — mirroring the existing modal-focus discipline
  (`EnforcementOverlay.tsx:54-57`, `SessionDetailCard` focus note `:111`).

---

## 6. How suppression layers with the existing enforcement exemptions

Two independent dimensions, kept independent (matching the F5.3 comment that
"disabling the alert hides the ALERT only — the lock itself is policy",
`proctorAlerts.mjs:114-116`):

- **Alerting dimension** — `alert_suppressions` (ALERT-1) gates whether an alert
  DOC is written, enforced in `upsertProctorAlert` (§3). A `fullscreen_enforcement`
  suppression means the admin console stops seeing that candidate's fullscreen
  alerts for that test.
- **Enforcement/locking dimension** — `enforcement_exemptions.fullscreen` gates
  whether the session LOCKS, enforced in `applyEnforcementViolation`
  (`enforcement.mjs:100-110`) and the self-report/reconcile guards
  (`sessionGates.mjs:141`, `enforcement.mjs:132`, `:176`). UNCHANGED by ALERT-1.

So suppressing `fullscreen_enforcement` alerts does NOT stop the lock — that still
requires the per-session `exempt` action. This is intentional and must be called
out in the admin Suppress tooltip (§7.3): **"Suppress hides the alert; it does not
exempt the candidate from enforcement. To stop fullscreen locking, use the
session's Fullscreen exemption."** The two controls are deliberately separate so an
admin can hush noise without silently disabling a hard block.

`raiseSwitchAwayAlerts` keeps its existing `enforcement_exemptions.switch_away`
early-return (`proctorAlerts.mjs:309-310`) AND now additionally passes through the
`upsertProctorAlert` suppression guard — both layers apply; either suppresses the
`tab_away` alert. No conflict (both paths just mean "don't write the alert").

---

## 7. Admin surface — the shared suppressed list + one-click Suppress

### 7.1 New `suppress` / `unsuppress` alert actions

Add to the alert-level action group (NOT the session-action group — suppression is
an ALERT-level control, like archive). Following `ALERT_ACTION_INFO`
(`alertActions.ts:77-80`):

```js
export const ALERT_ACTION_INFO = {
  archive: { … },        // unchanged
  unarchive: { … },      // unchanged
  suppress:   { label: "Suppress", tooltip: "Stop raising THIS alert type for THIS candidate in THIS test. Hides the alert only — does not exempt them from enforcement or delete evidence." },
  unsuppress: { label: "Stop suppressing", tooltip: "Resume raising this alert type for this candidate in this test." }
} as const;
```

The AlertRow's "Alert" action group (`AlertsConsole.tsx:401-411`) gains a Suppress
button next to Archive. One click posts the suppression entry derived straight from
the alert row's own fields (`alert.username_norm` / `candidateIdOf(alert)`,
`alert.contest_slug`, `alert.type`) — zero typing, exactly the "one-click suppress"
the brief asks for. For a `dispute_raised` alert, the Suppress button is wired to
suppress the **disputed** type (`alert.data.disputed_type`), not `dispute_raised`
itself — so an admin reviewing a candidate's dispute can hush the actual noisy
type in one click.

### 7.2 New admin API — list / add / remove suppressions

Add to `routes/alerts.mjs` (the alerts route factory, same ctx), all auth-first
`requireAdmin` (satisfying `routesAuthLint`, `alerts.mjs:23-25`):

```
GET  /api/admin/alert-suppressions          → { entries: [...] }   (the shared list)
POST /api/admin/alert-suppression           → { ok, entries }      add/remove one entry
     body: { action: "suppress" | "unsuppress", username_norm|candidate_id, contest_slug?, alert_type, reason? }
```

`POST` reads the doc, applies `sanitizeSuppressionEntry` (§2.2), dedupes on the
match key (§2.3) so a double-suppress is idempotent, removes on `unsuppress`,
caps the list at `SUPPRESSIONS_MAX`, writes back, and calls the cache
invalidation hook (§3.1). This mirrors `adminAlertAction`'s validate→mutate→report
shape (`alerts.mjs:163-193`) and `adminSaveAlertSettings`'s sanitize-then-set
shape (`:206-221`).

The `suppress` button on a row calls `POST /api/admin/alert-suppression` with
`action:"suppress"` and `source_alert_id: alert.id` for provenance.

### 7.3 The shared "Suppressed alerts" admin list

A small panel — reachable from the AlertsConsole header (a "Suppressed (N)"
button) or a sibling admin view — that GETs `/api/admin/alert-suppressions` and
renders the entries as rows: candidate, test, alert type, reason, who/when, and a
**Stop suppressing** button per row (POST `unsuppress`). This is the "shared
suppressed list" the brief specifies: every `(user, test, type)` suppression —
whatever its origin (a dispute-driven suppress, or a proactive admin suppress) —
lives in this ONE list, the same way archived alerts all live behind one "Show
archived" toggle.

Frontend types (`types.ts`): add `AlertSuppressionEntry`,
`AlertSuppressionsResponse`, `AlertSuppressionRequest`, and extend
`SessionAction`/alert-action plumbing minimally (suppression is an alert action,
so it threads through the existing `onArchive`-style callback, not the session
`onAction`).

---

## 8. End-to-end flow (the happy path)

1. Candidate switches tabs; `tab_away` alert is raised
   (`raiseSwitchAwayAlerts` → `upsertProctorAlert`), lands on the admin console.
   The candidate ALSO sees the hard-block overlay (it was a fullscreen exit, say).
2. Candidate believes it's a bug (their screen reader pulled focus). They press
   **Option B → Report a problem**, type a one-line note, submit.
   `POST /api/session/dispute-alert` raises an `info` `dispute_raised` alert with
   `data.disputed_type = "fullscreen_enforcement"`.
3. The dispute alert appears on the AlertsConsole. The admin reads it + the
   note + (if present) the evidence clip, agrees it's a genuine fault.
4. Admin clicks **Suppress** on the dispute row (one click) → suppresses
   `(alice, kpr-round-2, fullscreen_enforcement)`. If they ALSO want to stop the
   lock, the tooltip points them to the session's Fullscreen exemption (§6).
5. Cache invalidates; the next `upsertProctorAlert` for that tuple returns `null`
   — no further `fullscreen_enforcement` alerts for Alice in this test. The raw
   events keep flowing into evidence (platform-improvement signal retained).
6. Admin can later open the **Suppressed alerts** list and **Stop suppressing**
   to restore the alert.

---

## 9. Build phases (each ends green before the next)

1. **P1 — domain + storage (no UI).** `proctorAlerts.mjs`: add
   `dispute_raised` to the catalog, `SUPPRESSIBLE_ALERT_TYPES`,
   `sanitizeSuppressionEntry`, `isAlertSuppressed`, `getAlertSuppressions`, the
   `upsertProctorAlert` guard; `handler.mjs` ctx wiring + cache-invalidation
   widening. Unit tests: suppressed tuple → `upsertProctorAlert` returns null +
   writes nothing; `dispute_raised` never suppressed; sanitizer drops unknown
   types/keys; `isAlertSuppressed` `""`/`"_"` slug equivalence.
2. **P2 — candidate route.** `sessionGates.mjs` `sessionDisputeAlert` + dispatch
   line; tests: raises one idempotent `dispute_raised`, honours the global type
   disable, per-day dedupe.
3. **P3 — admin API.** `routes/alerts.mjs` GET list + POST suppress/unsuppress;
   dispatch lines; tests: add/idempotent/remove/cap/sanitize, auth-first.
4. **P4 — admin UI.** `alertActions.ts` action info; AlertsConsole Suppress
   button + Suppressed list panel; `api.ts` + `types.ts`; the `dispute_raised`
   row's "suppress the disputed type" wiring. Pure-logic tests in
   `alertActions.test.ts`.
5. **P5 — candidate UI.** `EnforcementOverlay` / `AnomalyPanel` Option A/B +
   confirm + copy; `api.ts reportAlertDispute`; `StudentApp` threading; overlay
   tests (`EnforcementOverlay.test.tsx`).

Lints to respect (all already enforced, none newly violated): `scopingLint`
(no raw `contest_slug` `.where` — the suppression doc is addressed by fixed id,
the list is filtered in memory, identical to alert-settings), `routesAuthLint`
(every new `admin*` route auth-first), `env-lint` (new doc-id constant captured at
handler load by value, like `alertSettingsId`), `canaryIsolation` (new dispatch
lines are additive and byte-stable).

---

## 10. Open questions for the maintainer

1. **Suppress vs. enforcement layering (§6)** — confirmed-intended that
   suppressing `fullscreen_enforcement` alerts does NOT stop the lock (admin must
   also exempt the session)? The alternative is a "Suppress + exempt" combo
   button on the row that does both in one click. I lean keep-separate (matches the
   F5.3 policy/alerting split) with a clear tooltip, but it's a UX call.
2. **Where the Suppressed list lives** — a panel inside AlertsConsole (a
   "Suppressed (N)" disclosure) or a dedicated admin nav view? I lean disclosure
   inside the console (suppression is alert-triage-adjacent), like "Show archived".
3. **Dispute severity** — `info` (proposed) keeps disputes out of the critical/
   warning counts; acceptable, or should a dispute be `warning` so it's harder to
   miss in triage?
4. **Per-test scope key** — `contest_slug` is the "test" identifier here. For a
   person-contest the slug is the per-test slug, which is correct; confirm there's
   no case where "test" should mean something finer (e.g. per-room) — I don't
   think so, but flagging since the brief says "for that test".

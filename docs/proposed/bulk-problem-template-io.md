# BANK-1 — Bulk export/import of problems + templates

**Status:** Proposed (code-grounded design). Roadmap item **BANK-1** (v1.1).
**Source intent:** owner request 2026-06-19 (captured plan:
`junk/nightrun-archive/feature-bulk-export-import-plan.md`).
**Author:** the agent, 2026-06-23.

> One-line scope: admin can multi-select problems and/or templates, **download** a
> single portable JSON bundle (a selected template pulls in its referenced
> problems), and **upload** that bundle back into the same or a different proctor
> instance — with duplicate detection and a sane cross-instance conflict model,
> built as a thin wrapper over the existing `validateProblemInput` /
> `validateTemplateInput` save paths.

---

## 0. Why this is a wrapper, not a rewrite

The problem bank and template store already have hardened, allow-listing
validators and idempotent write paths:

- Problems: `validateProblemInput(body)` → normalized doc, then
  `problemRef(id).set(item)` with `created_at`/`updated_at` stamping
  (`backend/src/routes/adminProblems.mjs:114-150`). Read via
  `getBankProblem(id)` (any status — `backend/src/problems.mjs:121-129`).
- Templates: `validateTemplateInput(body)` → normalized template, then
  `createTemplateDoc(template)` (atomic `.create()` with `-2/-3` slug collision
  loop — `backend/src/routes/adminTemplates.mjs:75-92`) or
  `templateRef(slug).set(item)` for updates. Read via `getTemplate(slug)`
  (`backend/src/templates.mjs:89-98`); list via `listTemplates()`.
- Every template entry must reference a real bank problem at save time:
  `requireKnownProblems(entries)` (`adminTemplates.mjs:67-73`).

The import path **re-uses these verbatim**. We never spread bundle JSON into
Firestore; every imported item passes back through the same validator a hand
author would hit. Storage shape of a problem/template doc is **unchanged**, with
exactly two additive, optional provenance fields (see §1). This keeps back-compat
byte-for-byte for every existing doc and means import inherits all existing
bounds/guards (statement caps, test caps, language allow-list, live-reference
guard) for free.

---

## 1. Data model: portable identity (the additive fields)

Today a problem's identity is its `id` (the slug, `PROBLEM_BOUNDS.ID_PATTERN`)
and a template's is its `slug`. **The slug is the wrong cross-instance key**:
instance A and instance B can both have a `two-sum` problem that are completely
different problems, and the same logical problem can land under `two-sum` on A
and `two-sum-2` on B (slug collision suffixing — `createTemplateDoc`,
`adminTemplates.mjs:79-89`). So we add a travelling identity.

Two new **optional** fields on each problem doc and each template doc:

| field | type | meaning |
|---|---|---|
| `portable_id` | string (uuid v4, lowercase, 36 chars) | Stable opaque identity. Generated **once** at first author/import. Travels with the item across export→import forever. Never changes on edit. **This is the cross-instance match key.** |
| `origin` | `{ instance, exported_from?, at }` (object, optional) | Provenance breadcrumb. `instance` = the instance that first created the `portable_id`; set once. Diagnostic only — never a match key, never a guard input. |

We deliberately **do not** store a `version` integer or a `content_hash` on the
doc. Reasons, after pressure-testing the captured plan's "version + hash + lineage"
model:

- A monotonic `version` is only meaningful if every edit path bumps it. Proctor
  has multiple write paths to a problem (admin save, clone-hackerrank skill, the
  import we're adding) and to a template (create/update/clone/archive). A version
  counter that any path can forget to bump silently corrupts the conflict
  decision. Avoided.
- A *stored* `content_hash` is redundant: the importer can compute the canonical
  hash of the **local** doc and of the **incoming** doc at import time and compare
  them directly. Nothing needs to be persisted for that to work, and an unstamped
  legacy doc participates correctly with zero backfill.

So conflict detection is **content-hash-at-import-time** (computed, not stored)
keyed by **`portable_id`** (stored). This is the minimum durable state that makes
dedup + the A→B→A round-trip decidable.

### 1.1 Canonical content hash (the dedup primitive)

A pure function in a new module `backend/src/bulkIo.mjs`:

```
canonicalProblemHash(doc)  -> sha256 hex of canonicalProblemContent(doc)
canonicalTemplateHash(doc) -> sha256 hex of canonicalTemplateContent(doc)
```

`canonicalProblemContent(doc)` builds a **stable-key-ordered** object of *only the
authored content* — explicitly **excluding** `portable_id`, `origin`,
`created_at`, `updated_at` (and the `preset`/`references` projections, which are
never on a stored doc). It runs the doc through the SAME normalization the
validator does (so e.g. an absent `statement_format` and `"plain"` hash equal,
matching the storage rule at `problems.mjs:246`), then `JSON.stringify` with keys
sorted recursively. Fields hashed for a problem: `id, title, statement,
statement_format(normalized), languages(sorted), cpuTimeLimit, memoryLimit,
points, scoring, status, tags(sorted), sampleTests(ordered), hiddenTests(ordered),
stubs(key-sorted)`.

For a template: `name, description, problems[](each {problem_id, points,
order} — but see §2.2: the bundle stores problems by `portable_id`, so the hash
is computed over the *portable* problem refs, not the local slugs), defaults(deep,
key-sorted)`.

> **Why `id`/`slug` is *included* in the problem/template hash but the match key
> is `portable_id`:** renaming a slug is a content change a human cares about
> (it's the candidate-visible problem id), so a slug change should count as
> "differs" and not be silently deduped away. Matching is by `portable_id`;
> *equality* is by content hash including the slug.

### 1.2 Backfill (lazy, no migration job)

Existing docs have no `portable_id`. We do **not** run a batch migration. Instead:

- **Export** of a problem/template that lacks a `portable_id` **mints one and
  writes it back** to the source doc (a `set({...}, {merge:true})` stamping
  `portable_id` + `origin`) as part of the export transaction, so the exported
  bundle and the source doc agree forever after. This is a metadata-only write;
  it does not touch authored content and does not bump `updated_at` (we stamp a
  separate `portable_id_at` if we want a breadcrumb — optional).
- **Authoring** (`adminSaveProblem` / `adminCreateTemplate`): mint a
  `portable_id` on first create if absent. One-line addition in the save path.
- **Import**: an imported item always carries a `portable_id` from the bundle; if
  a *legacy local* doc with no `portable_id` is matched (see §3.3), we treat it as
  un-keyed and fall to slug-based matching for that one item.

This means the feature works on a brand-new instance and on the current
production instance with no downtime and no data backfill step.

---

## 2. Bundle format (the portable file)

A single self-describing **JSON** file. No zip dependency (mirrors the deliberate
"no heavy zip dep" choice for contest export — `handler.mjs:1941-1949`). Problems
+ their hidden tests are text and compress poorly-but-fine as JSON; a 20-problem
template bundle is tens-to-low-hundreds of KB. If a future bundle is genuinely
huge we revisit, but JSON is correct for v1.

```jsonc
{
  "kind": "proctor.bank-bundle",        // magic string — reject anything else
  "bundle_version": 1,                  // schema version; importer migrates/﻿rejects
  "exported_at": "2026-06-23T10:00:00.000Z",
  "exported_from": "your-gcp-project-id",// instance label (diagnostic)
  "counts": { "problems": 7, "templates": 2 },
  "problems": [
    {
      // FULL authored problem doc (admin surface — includes hiddenTests),
      // exactly the shape validateProblemInput accepts, PLUS portable_id/origin.
      "portable_id": "9f1c…",
      "id": "two-sum",
      "title": "Two Sum",
      "statement": "…",
      "statement_format": "markdown",   // omitted when plain
      "languages": ["python","cpp"],
      "cpuTimeLimit": 5, "memoryLimit": 128000,
      "points": 100, "scoring": "per_test", "status": "published",
      "tags": ["arrays"],
      "stubs": { "python": "…" },        // omitted when none
      "sampleTests": [ { "input": "…", "expected": "…" } ],
      "hiddenTests": [ { "input": "…", "expected": "…" } ],
      "origin": { "instance": "your-gcp-project-id", "at": "2026-06-01T…" }
    }
  ],
  "templates": [
    {
      "portable_id": "3a7e…",
      "slug": "weekly-set",             // source slug (diagnostic / fallback)
      "name": "Weekly set",
      "description": "…",
      "defaults": { /* full normalized defaults block */ },
      // Problems referenced BY PORTABLE ID (+ a slug hint for human-readable
      // diffs / dangling-ref messages). Never by raw local slug alone.
      "problems": [
        { "problem_portable_id": "9f1c…", "problem_id_hint": "two-sum",
          "points": null, "order": 0 }
      ]
    }
  ]
}
```

### 2.1 A template export is self-contained

When the export selection includes a template, the bundle **embeds the full
content of every problem that template references** (resolved through the
template's `problems[]` → each `problem_id` → `getBankProblem`). This realizes
the "select a template, all its questions download too" requirement. A problem
already present in the bundle from a direct selection is embedded once (dedupe by
`portable_id` during bundle assembly). Problems can also be exported alone
(no template) — the `templates` array is then empty.

### 2.2 Why templates reference problems by `portable_id`

The template's stored shape uses `problem_id` (the slug). But slugs are
instance-local, so the bundle **translates** each entry to
`problem_portable_id` (looked up from the referenced problem's doc, minting one
if needed — §1.2) plus a `problem_id_hint` for readable messages. On import the
reverse translation happens: each `problem_portable_id` is resolved to whatever
**local** slug that portable id landed on (§3.4), and only then is the template
written through `validateTemplateInput` + `requireKnownProblems`. This is what
makes a template survive an instance where its problems live under different
slugs.

A template entry whose `problem_portable_id` cannot be resolved on import (the
problem was neither in the bundle nor already local) is a **dangling reference** —
handled in §3.4, never written as a silent broken link (`requireKnownProblems`
would 400 anyway; we surface it cleanly in the preview instead).

---

## 3. Dedup + cross-instance versioning (the conflict model)

This is the heart of the request: *"download from A → change on B → download
again → upload back to A. Probably a key and a -1, or it asks. Take that decision
and go ahead."*

**Decision: per-item, match by `portable_id`, default action chosen automatically
from the content-hash comparison, with a mandatory dry-run preview where the admin
can override per item before anything is written. Default for a genuine conflict
is FORK (import as a new `-2` item), never silent overwrite.**

### 3.1 The four cases (per problem; templates §3.4)

For each incoming item, find the local doc with the same `portable_id`
(scan: one bounded `limit(500)` read of each collection, build a
`portable_id → doc` map — both collections are low-cardinality, same assumption
`findProblemReferences` already relies on, `contestProblems.mjs:35-37`).

| # | Situation | Default action | Rationale |
|---|---|---|---|
| **A. New** | No local doc with this `portable_id` | **create** | Nothing to conflict with. |
| **B. Identical** | Local exists, `content_hash` equal | **skip (dedup)** | True no-op. This is "handle duplications" — re-importing an unchanged round-trip does nothing. |
| **C. Incoming differs, local unchanged-since-export** | Local exists, differs, and the bundle says it was exported FROM a state equal to the local content | **update in place** (default yes) | The importer is strictly newer; A never touched it. Safe to advance. |
| **D. Divergent** | Local exists, differs, and the local content is NOT what the bundle was forked from | **fork** → import as a NEW problem with a fresh slug (`<id>-2`, `-3`…) and a fresh `portable_id`, annotated "forked from `<portable_id>`" | Both sides edited since the fork — overwriting would lose A's edits. This is the "-1 kind of thing" from the request. |

### 3.2 How we tell C from D without a stored version/lineage

We need to know whether the **local** doc is "the thing the bundle was exported
from" (→ C, safe update) or "something the local admin has since changed" (→ D,
fork). With no stored lineage, we use a **base-hash carried in the bundle**:

- At export, for each item we record `base_hash` = the content hash of the item
  **as exported** (i.e. its own current content hash). The bundle item is
  self-describing: `content_hash` = hash of the content in the bundle.
- At import we compute `local_hash` = hash of the local doc.
  - `local_hash == content_hash` → **B (identical)**.
  - `local_hash != content_hash` → differs. We cannot *prove* C vs D without
    lineage, so we choose the **safe** disambiguation:
    - We additionally carry, per item, the `content_hash` the bundle was
      **derived from on the exporting instance at its previous import** — i.e. a
      one-deep `parent_hash`. On a first-ever export `parent_hash` is the item's
      own hash. On a re-export of an item that was itself imported, the importer
      stamps the resolved `parent_hash` so the lineage carries one hop. If
      `local_hash == parent_hash`, the local side is exactly the ancestor the
      bundle forked from → **C (update)**. Otherwise → **D (fork)**.

> **Honest simplification for v1 (recommended):** one-deep `parent_hash` covers
> the exact scenario described above (A→B→A) correctly: B's bundle carries
> `parent_hash` = the hash B imported from A; if A is untouched, `local_hash` on A
> equals that `parent_hash` → C (update A in place); if A *also* changed,
> `local_hash != parent_hash` → D (fork). It does **not** attempt full multi-hop
> lineage (A→B→C→A with edits at every hop) — that degrades to D (fork), which is
> the safe-by-default outcome (no data loss, admin sees it in the preview and can
> override to overwrite). We accept that boundary explicitly rather than build a
> lineage DAG. If real usage shows multi-hop chains, revisit with a short
> `lineage: [hash,…]` array (bounded length) — additive, no format break.

`parent_hash` and `content_hash` live **in the bundle item only**, never on the
stored doc. Stored docs stay clean (just `portable_id` + `origin`).

### 3.3 Legacy / un-keyed local docs

If a local doc has **no** `portable_id` (pre-feature authoring) and the bundle
item's slug `id` collides with it, we cannot match by portable id. Default:
treat as **D-style fork-or-adopt prompt** — the preview shows "local `two-sum`
has no portable identity; incoming `two-sum` (portable `9f1c…`) — [Adopt: stamp
this portable id onto the local doc and update] / [Keep both: import as
`two-sum-2`] / [Skip]". Default selection = **Keep both** (never silently
overwrite an un-keyed local doc we can't prove is the same thing). Adopt is the
one-click "yes these are the same, take it over" path.

### 3.4 Templates

Templates run the **same A/B/C/D** machine on the *template's own* `portable_id`
and content hash, but with a dependency step first:

1. **Resolve every referenced problem** (`problem_portable_id`) to a local slug,
   running each problem through §3.1 first. A referenced problem might end up:
   created, skipped(=already present), updated, or **forked** (→ now lives at
   `two-sum-2`). The template's entry is rewritten to point at the **resolved
   local slug** for that portable id (the forked slug if it forked). This is the
   captured plan's "link the template to the right resolved id; never leave a
   dangling ref."
2. A referenced `problem_portable_id` that resolves to **nothing** (not in bundle,
   not local) is a dangling ref → the template import for that template is
   **blocked in the preview** with a clear "references problem `…` (hint:
   `two-sum`) which is not in this bundle and not on this instance" message. The
   admin can either add the problem to the bundle and re-import, or (override)
   drop that entry. We never write a template with a broken ref
   (`requireKnownProblems` is the backstop, `adminTemplates.mjs:67-73`).
3. Then the template itself runs A/B/C/D. A **fork** of a template mints a new
   slug via the existing `createTemplateDoc` `-2/-3` loop and a new
   `portable_id`. An **update** writes through the update path
   (`templateRef(slug).set(item)`), preserving `created_at`. Slug renames never
   re-slug (the existing rule, `adminTemplates.mjs:155-157`).

### 3.5 Dry-run preview is mandatory ("or it asks")

Import is **two-phase**:

1. `POST /api/admin/bank-import-preview` — validates the bundle, runs the whole
   A/B/C/D resolution **without writing**, returns a per-item plan:
   `{ problems:[{portable_id, id, action, target_slug, reason}], templates:[…],
   summary:{created,unchanged,updated,forked,blocked} }`.
2. `POST /api/admin/bank-import-commit` — takes the bundle **plus** an optional
   `overrides` map (`{ "<portable_id>": "create|update|fork|skip|adopt" }`) and
   the `preview_token` (a hash of the bundle the preview was computed against, so
   commit can detect a changed bundle and refuse). Applies the resolved actions.

The preview is the "it asks." The default plan is the "automatic and safe." This
satisfies both halves of the "-1 or it asks" requirement in one flow.

### 3.6 What the default is, stated plainly

- **Unchanged round-trip → silently skipped** (dedup).
- **Importer strictly newer, local untouched → updated in place** (the common,
  desired "I edited it elsewhere, push it back" case).
- **Both sides changed → forked to `-2`, nothing lost, shown in preview** (the
  conflict case; admin can override to overwrite if they truly mean it).
- **No silent overwrite, ever.** The only overwrite is an explicit per-item
  override or the unambiguous "local untouched" C case.

---

## 4. Endpoints

All admin-only (`requireAdmin(req)` first statement — `routesAuthLint` pins it),
wired as a new route factory `makeAdminBankIoRoutes(ctx)` under
`backend/src/routes/adminBankIo.mjs`, instantiated in `handler.mjs` like the
other route factories and destructured into the dispatch table
(`handler.mjs:~1390-1400` neighborhood). Pure logic (hashing, the A/B/C/D
resolver, bundle assembly/parse) lives in a testable `backend/src/bulkIo.mjs`
with no store/env (mirrors `contestProblems.mjs` / `dataLifecycle.mjs`).

| method + path | body / query | returns |
|---|---|---|
| `POST /api/admin/bank-export` | `{ problem_ids: string[], template_slugs: string[] }` | The full bundle JSON (`§2`). Server resolves template→problem embedding + mints missing `portable_id`s (writing them back). Response is the bundle object; the frontend turns it into a downloaded `.json` file (client-side `Blob`, no GCS round-trip needed — these are small). |
| `POST /api/admin/bank-import-preview` | `{ bundle: <object> }` | The per-item plan + summary (`§3.5`). No writes. |
| `POST /api/admin/bank-import-commit` | `{ bundle, overrides?, preview_token }` | `{ ok, applied: { created, updated, forked, skipped, blocked }, problems:[…], templates:[…] }`. Writes through the existing save paths. |

Notes:
- **Export response is inline JSON, not a GCS object.** Unlike contest export
  (which is heavy evidence and uses GCS + signed URL — `handler.mjs:1947-1959`),
  a problem/template bundle is small and has no PII/evidence, so returning it in
  the response body and letting the browser save it is simpler and avoids a
  bucket write + lifecycle concern. (If we later want a server-side archive of
  exports, that's an additive enhancement.)
- **Body size:** import bundles are bounded by the existing per-problem caps
  (statement 20k, 50 hidden tests × 10k, `PROBLEM_BOUNDS`) and a new bundle cap
  (e.g. `MAX_BUNDLE_PROBLEMS = 200`, `MAX_BUNDLE_TEMPLATES = 50`) so a malicious
  upload can't OOM. Reject oversized bundles with a clean 400.
- **Audit:** commit calls `writeAudit({ action: "bank_import", counts, … },
  adminActor(req, body), now)` (same pattern as `contest_export`,
  `handler.mjs:1969-1974`). Export writes a `bank_export` audit line.
- **Atomicity:** commit is not a single Firestore transaction (cross-collection,
  potentially >500 writes). It applies problems first (so template refs resolve),
  then templates, and returns a per-item result list. A mid-batch failure leaves
  earlier items applied; the response reports exactly what landed, and re-running
  the commit is **idempotent** (already-applied items hash-match → skip). This
  idempotency is the safety net instead of a true transaction.

---

## 5. Frontend / UI touchpoints

Two existing admin panels gain multi-select + an export/import bar. Minimal,
mirroring the existing list-row layout.

### 5.1 `frontend/src/admin/ProblemBank.tsx`

- Add a `Set<string> selectedIds` state. Render a checkbox on each problem row
  (the `problems.map((p) => …)` block, `ProblemBank.tsx:159-179`).
- A header action group (next to Reload / New problem, `ProblemBank.tsx:129-138`)
  gains **"Export selected (N)"** (disabled when `selectedIds` empty) and
  **"Import bundle…"** (hidden `<input type="file" accept=".json">`).
- Export → `bankExport(password, {problem_ids:[...selectedIds], template_slugs:[]})`
  → receive bundle object → `downloadJson(bundle, "proctor-bundle-<stamp>.json")`
  (a tiny client helper, Blob + anchor click; no new dep).

### 5.2 `frontend/src/admin/TemplatesPanel.tsx`

- Same `selectedSlugs` multi-select on the template rows
  (`TemplatesPanel.tsx:179-210`).
- **"Export selected (N)"** → `bankExport(password, {problem_ids:[],
  template_slugs:[...selectedSlugs]})`. The server embeds each template's
  problems (§2.1), so the downloaded bundle is self-contained.
- Templates and problems can be exported **together** from either panel by also
  passing the other panel's selection; v1 keeps it simple — each panel exports
  its own selection, and because a template bundle auto-includes its problems, a
  "template + extra standalone problems" export is the rare case. (If wanted, a
  small shared selection store unifies both — deferred.)

### 5.3 Import preview modal (shared component)

A new `frontend/src/admin/BankImportDialog.tsx`:

1. User picks a `.json` file → parse client-side → `bankImportPreview(password,
   bundle)`.
2. Render the plan as a table: per item — name, action badge
   (Create / Unchanged / Update / **Fork→`-2`** / **Blocked**), reason, and a
   per-row `<select>` to override (Create/Update/Fork/Skip/Adopt, constrained to
   the legal set for that item).
3. Footer summary "N created · M unchanged · K updated · J forked · B blocked"
   + a **Apply import** button (disabled while any template is Blocked with no
   override resolving it).
4. Apply → `bankImportCommit(password, {bundle, overrides, preview_token})` →
   show the applied result, then `load()` both panels.

This dialog IS the "it asks" path. Default plan shown; the admin clicks Apply to
take the automatic-safe path, or tweaks any row first.

### 5.4 `frontend/src/api.ts`

Three thin client fns next to the existing problem/template ones
(`fetchProblems` ~`api.ts:780+` pattern): `bankExport`, `bankImportPreview`,
`bankImportCommit` — each a `request<T>(path, {method:"POST", headers:{
"x-admin-password":password }, body: JSON.stringify(…)})`. Demo-mode stubs return
canned bundles so the offline admin demo still renders the flow.

### 5.5 `frontend/src/types.ts`

Add `BankBundle`, `BankImportPlan`, `BankImportItemAction` types mirroring §2/§3.5.

---

## 6. Edge cases (must be handled in the build)

1. **Template references a SKIPPED/FORKED problem** → resolve to the right local
   slug; if forked, point at the fork. Never dangling (§3.4.1).
2. **Dangling problem ref** (not in bundle, not local) → template Blocked in
   preview with a clear message (§3.4.2). Backstopped by `requireKnownProblems`.
3. **Seed problems/templates** (`SEED_PROBLEMS` `sum-two`, `SEED_TEMPLATES`
   `system-check`): exportable (read via `getBankProblem`/`getTemplate` which see
   seeds). On import, a seed-slug collision follows the existing shadow rule — a
   bundle problem with `id:"sum-two"` and a *different* portable id imports as a
   new doc shadowing/owning that slug only if hashes differ (D→fork to
   `sum-two-2`); importing the *same* seed content is a B (skip). Creating a
   template at a **bare seed slug** is already blocked by `createTemplateDoc`
   (`adminTemplates.mjs:81`) — fork suffixing handles it.
4. **`bundle_version` / `kind` mismatch** → `bank-import-preview` rejects with a
   400 `unsupported_bundle` (or migrates a known-older version). Self-describing
   `kind:"proctor.bank-bundle"` magic guards against importing an unrelated JSON.
5. **Bundle exceeds caps** (§4) → 400 before any resolution.
6. **Live-reference guard interaction:** importing an **update** to a problem that
   an OPEN contest references hits the same `live_edit_confirmation_required` /
   `problem_referenced` guards as `adminSaveProblem`
   (`adminProblems.mjs:126-139`). The preview surfaces this as a Blocked/needs-
   confirm row; commit honors a per-item `confirm_live_edit` override. We **reuse
   the existing guard** — import is not a backdoor around it.
7. **Status on import:** a `published` problem imports as `published` (round-trip
   fidelity, matching the clone-hackerrank skill which publishes). The preview
   shows status so the admin isn't surprised.
8. **Self-import (same instance):** every item is B (identical) → all-skip no-op.
   Good safety property.
9. **Partial commit failure** → idempotent re-run (§4 atomicity note).

---

## 7. Phased build plan

Each phase: build → `npm test` (backend + frontend) → orchestrator verifies green
→ commit. Tree stays green every phase.

- **Phase 0 — portable identity + hashing (pure core).**
  `backend/src/bulkIo.mjs`: `canonicalProblemContent/Hash`,
  `canonicalTemplateContent/Hash`, uuid minting, the A/B/C/D `resolveItem`
  decision function (pure — takes incoming item + local map + overrides, returns
  an action plan). Unit tests for every case incl. C-vs-D via `parent_hash`,
  legacy un-keyed, identical-skip. **No store, no endpoints.** Add `portable_id`
  minting to `adminSaveProblem` / `adminCreateTemplate` (one line each + a test
  that a freshly authored item gets a stable id and a second save keeps it).

- **Phase 1 — export endpoint.** `makeAdminBankIoRoutes` + `bank-export`: gather
  selected problems/templates, embed template problems, translate refs to
  `problem_portable_id`, mint+write-back missing portable ids, assemble bundle,
  audit. Backend tests: single problem, template-with-problems (self-contained),
  mixed selection, dedupe of a problem selected directly *and* via a template,
  portable-id write-back.

- **Phase 2 — import preview (read-only resolver).** `bank-import-preview`:
  parse+validate bundle (`kind`/`version`/caps), build local `portable_id` maps,
  run `resolveItem` for every problem then template (with dependency resolution
  + dangling detection), return the plan. Tests: each of A/B/C/D for problems and
  templates, dangling ref blocked, legacy adopt, bundle-version reject,
  oversized reject.

- **Phase 3 — import commit (the writes).** `bank-import-commit`: re-resolve with
  `overrides`, apply problems (through `validateProblemInput` + the existing
  guard-aware save) then templates (through `validateTemplateInput` +
  `requireKnownProblems` + create/update), honor `confirm_live_edit`, audit,
  return applied result. Tests: create/update/fork/skip/adopt land correctly;
  forked slug + fresh portable id; idempotent re-run; live-reference guard
  surfaced + confirm path; partial-failure report.

- **Phase 4 — frontend.** Multi-select on both panels, export download,
  `BankImportDialog` with the override table, `api.ts` fns + demo stubs,
  `types.ts`. Vitest for the client resolver-display mapping + a render test of
  the dialog. Then the mandated browser E2E (the project's persona-driven,
  screenshot-documented E2E pass): export a real template, re-import to a
  scratch instance, screenshot the preview + applied result.

- **Phase 5 — docs + triple review.** `docs/features/` reference page; mark this
  proposal Implemented; correctness + spec-conformance + security review over the
  full diff (focus: auth-first on all three routes, no client JSON spread into
  storage, bundle caps enforced, guard reuse intact).

---

## 8. Open questions for the maintainer

1. **Multi-hop lineage:** v1 uses one-deep `parent_hash` (A→B→A is exact;
   deeper chains degrade to *fork*, which is safe). Acceptable, or do you want
   full lineage tracking in v1? (Recommend: ship one-deep, revisit if needed.)
2. **Combined problem+template export from one click:** v1 exports per-panel
   selection (a template auto-pulls its problems). Want a single unified
   "selection cart" across both tabs in v1, or is per-panel fine? (Recommend:
   per-panel for v1.)
3. **Server-side export archive:** v1 returns the bundle inline (browser saves
   it), no GCS copy. Want exports also archived to a bucket like contest exports?
   (Recommend: no — keep it stateless; add later if a "re-download last export"
   need appears.)

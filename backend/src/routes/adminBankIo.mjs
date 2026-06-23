// backend/src/routes/adminBankIo.mjs — BANK-1 (F11): bulk export/import of
// problems + templates as a route FACTORY (decomp pattern §A2/§A8, same shape as
// makeAdminProblemsRoutes / makeAdminTemplatesRoutes). makeAdminBankIoRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the three
// route handlers (adminBankExport / adminBankImportPreview / adminBankImportCommit).
// handler.mjs instantiates this at module scope and destructures the route
// handlers into the SAME names the dispatch table calls.
//
// Every route handler is AUTH-FIRST: requireAdmin(req) is the first statement
// (routesAuthLint pins this).
//
// This is the SPEC's "thin wrapper, not a rewrite" (docs/proposed/
// bulk-problem-template-io.md §0): the pure hashing / A-B-C-D resolver / bundle
// shaping live in src/bulkIo.mjs; every import WRITE goes back through the SAME
// validateProblemInput / validateTemplateInput + requireKnownProblems save paths
// a hand author hits, so import inherits all existing bounds/guards for free.
// Bundle JSON is NEVER spread into Firestore.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Everything stateful or env-captured arrives through ctx.

import {
  assembleBundle, bundleToken, canonicalProblemHash, canonicalTemplateHash,
  isValidPortableId, mintPortableId, MAX_BUNDLE_PROBLEMS, MAX_BUNDLE_TEMPLATES,
  problemToBundleItem, resolveProblem, templateToBundleItem, validateBundleEnvelope
} from "../bulkIo.mjs";

export function makeAdminBankIoRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    badRequest,
    httpError,
    httpErrorWith,
    // collection names + caps (captured at handler load, per ?buster instance)
    problemsCollection,
    templatesCollection,
    contestsCollection,
    problemsQueryLimit,
    // problem domain fns
    validateProblemInput,
    getBankProblem,
    // template domain fns
    getTemplate,
    listTemplates,
    validateTemplateInput,
    // the pure contest-reference finder (live-edit guard reuse)
    findProblemReferences,
    // template-block helpers owned by makeAdminTemplatesRoutes (by reference)
    requireKnownProblems,
    createTemplateDoc,
    // provenance + audit
    instanceLabel,
    writeAudit,
    adminActor
  } = ctx;

  function problemRef(id) {
    return getFirestore().collection(problemsCollection).doc(id);
  }
  function templateRef(slug) {
    return getFirestore().collection(templatesCollection).doc(slug);
  }

  // One bounded read of each low-cardinality collection -> a portable_id→doc map
  // and a slug→doc map (the same limit(500) bound findProblemReferences relies on
  // — contestProblems.mjs). Seeds are NOT merged here: a seed only participates
  // once it has been authored into a doc (export mints+writes a portable_id onto
  // the seed-or-doc; a bare unexported seed has no portable identity to match).
  async function localProblemMaps() {
    const snapshot = await getFirestore().collection(problemsCollection).limit(problemsQueryLimit).get();
    const byPortableId = new Map();
    const bySlug = new Map();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data?.id) bySlug.set(data.id, data);
      if (isValidPortableId(data?.portable_id)) byPortableId.set(data.portable_id, data);
    }
    return { byPortableId, bySlug };
  }

  async function localTemplateMaps() {
    const templates = await listTemplates();
    const byPortableId = new Map();
    const bySlug = new Map();
    for (const template of templates) {
      if (template?.slug) bySlug.set(template.slug, template);
      if (isValidPortableId(template?.portable_id)) byPortableId.set(template.portable_id, template);
    }
    return { byPortableId, bySlug, all: templates };
  }

  // Lazy backfill (§1.2): an exported problem that lacks a portable_id mints one
  // and writes it back (metadata-only merge — never touches authored content,
  // never bumps updated_at). Returns the portable_id to embed.
  async function ensureProblemPortableId(doc, now) {
    if (isValidPortableId(doc.portable_id)) return doc.portable_id;
    const portableId = mintPortableId();
    const origin = doc.origin && typeof doc.origin === "object"
      ? doc.origin
      : { instance: instanceLabel, at: now };
    await problemRef(doc.id).set({ portable_id: portableId, origin, portable_id_at: now }, { merge: true });
    doc.portable_id = portableId;
    doc.origin = origin;
    return portableId;
  }

  async function ensureTemplatePortableId(template, now) {
    if (isValidPortableId(template.portable_id)) return template.portable_id;
    const portableId = mintPortableId();
    const origin = template.origin && typeof template.origin === "object"
      ? template.origin
      : { instance: instanceLabel, at: now };
    // A bare seed preset (preset:true, no doc) cannot be merged-into in place —
    // materializing it here would be a surprising side effect; instead we mint an
    // in-memory id for the bundle and let import treat the seed export like a
    // fresh authored item. Only a materialized doc gets the write-back.
    if (template.preset) {
      template.portable_id = portableId;
      template.origin = origin;
      return portableId;
    }
    await templateRef(template.slug).set({ portable_id: portableId, origin, portable_id_at: now }, { merge: true });
    template.portable_id = portableId;
    template.origin = origin;
    return portableId;
  }

  // ---- POST /api/admin/bank-export ------------------------------------------
  // { problem_ids: string[], template_slugs: string[] } -> the full bundle (§2).
  // Selected templates embed the FULL content of every problem they reference
  // (resolved through getBankProblem); a problem selected directly AND via a
  // template is embedded once (dedupe by portable_id during assembly).
  async function adminBankExport(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const problemIds = Array.isArray(body.problem_ids) ? body.problem_ids.map(String) : [];
    const templateSlugs = Array.isArray(body.template_slugs) ? body.template_slugs.map(String) : [];
    if (!problemIds.length && !templateSlugs.length) return badRequest("select at least one problem or template");
    if (problemIds.length > MAX_BUNDLE_PROBLEMS) return badRequest("too many problems selected");
    if (templateSlugs.length > MAX_BUNDLE_TEMPLATES) return badRequest("too many templates selected");

    const now = new Date().toISOString();

    // Gather the templates first so their referenced problems can be pulled in.
    const templates = [];
    const seenTemplateSlugs = new Set();
    for (const slug of templateSlugs) {
      if (seenTemplateSlugs.has(slug)) continue;
      seenTemplateSlugs.add(slug);
      const template = await getTemplate(slug);
      if (!template) throw httpError(404, "template_not_found");
      templates.push(template);
    }

    // The problem set = directly-selected ids ∪ every id referenced by a selected
    // template. getBankProblem sees seeds + docs (any status).
    const problemDocs = new Map(); // id -> doc (deduped by slug; portable id deduped after mint)
    const wantIds = new Set(problemIds);
    for (const template of templates) {
      for (const entry of template.problems || []) wantIds.add(entry.problem_id);
    }
    for (const id of wantIds) {
      const doc = await getBankProblem(id);
      if (!doc) {
        // A directly-selected missing problem is a hard 404; a template's
        // dangling ref is surfaced as a bundle hint (null portable id) instead.
        if (problemIds.includes(id)) throw httpError(404, "problem_not_found");
        continue;
      }
      problemDocs.set(id, doc);
    }

    // Mint+write-back portable ids, then build the slug→portable_id map the
    // template translation needs, deduping the embedded problems by portable id.
    const slugToPortableId = new Map();
    const problemItems = [];
    const seenPortableIds = new Set();
    for (const doc of problemDocs.values()) {
      const portableId = await ensureProblemPortableId(doc, now);
      slugToPortableId.set(doc.id, portableId);
      if (seenPortableIds.has(portableId)) continue;
      seenPortableIds.add(portableId);
      problemItems.push(problemToBundleItem(doc));
    }

    const templateItems = [];
    for (const template of templates) {
      await ensureTemplatePortableId(template, now);
      templateItems.push(templateToBundleItem(template, slugToPortableId));
    }

    const bundle = assembleBundle({
      problems: problemItems, templates: templateItems, instanceLabel, exportedAt: now
    });

    await writeAudit({
      action: "bank_export",
      counts: bundle.counts
    }, adminActor(req, body), now);

    return bundle;
  }

  // ---- the shared resolution pass (preview + commit re-run the SAME plan) -----
  // PURE-ish: reads the local maps, runs resolveProblem for every bundle problem,
  // then resolves each template's deps + the template's own A/B/C/D. `overrides`
  // is the per-portable_id override map (commit only). Returns the plan WITHOUT
  // writing. `live` (commit) carries open-contest reference info for the guard.
  async function resolvePlan(bundle, overrides) {
    const ov = overrides && typeof overrides === "object" ? overrides : {};
    const { byPortableId, bySlug } = await localProblemMaps();
    const tplMaps = await localTemplateMaps();

    // Slugs taken across the local bank PLUS any fork slug we plan in this batch,
    // so two divergent imports never plan the same fork slug.
    const takenSlugs = new Set(bySlug.keys());
    // resolved portable_id -> local slug it will land on (for template ref fixup)
    const portableToTargetSlug = new Map();

    const problems = [];
    for (const incoming of bundle.problems) {
      const plan = resolveProblem({
        incoming, byPortableId, bySlug, takenSlugs, override: ov[incoming?.portable_id]
      });
      if (plan.target_slug) {
        takenSlugs.add(plan.target_slug);
        if (isValidPortableId(plan.portable_id)) portableToTargetSlug.set(plan.portable_id, plan.target_slug);
      }
      problems.push(plan);
    }

    // Templates: resolve each problem ref to its local target slug first, detect
    // dangling refs, then run the template's own A/B/C/D.
    const templateTakenSlugs = new Set(tplMaps.bySlug.keys());
    const templates = [];
    for (const incoming of bundle.templates) {
      const refResults = [];
      const dangling = [];
      for (const entry of incoming.problems || []) {
        const pid = entry.problem_portable_id;
        let targetSlug = isValidPortableId(pid) ? portableToTargetSlug.get(pid) : undefined;
        if (!targetSlug && isValidPortableId(pid) && byPortableId.has(pid)) {
          targetSlug = byPortableId.get(pid).id; // already local, unchanged/skip
        }
        if (!targetSlug) {
          dangling.push({ problem_portable_id: pid || null, hint: entry.problem_id_hint || null });
        } else {
          refResults.push({ problem_id: targetSlug, points: entry.points ?? null, order: entry.order });
        }
      }

      const base = { portable_id: incoming?.portable_id, slug: incoming?.slug, name: incoming?.name };
      if (dangling.length) {
        templates.push({ ...base, action: "blocked", target_slug: null, reason: "dangling_problem_refs", dangling });
        continue;
      }

      // The template's content hash is computed over the PORTABLE refs (stable
      // across instances), matching the export-side hash (bulkIo §1.1/§2.2).
      const incomingEntries = (incoming.problems || []).map((e) => ({
        problem_portable_id: e.problem_portable_id, points: e.points ?? null, order: e.order
      }));
      const incomingHash = canonicalTemplateHashOf(incoming, incomingEntries);
      const parentHash = incoming?.parent_hash || incomingHash;
      const override = ov[incoming?.portable_id];

      const local = isValidPortableId(incoming?.portable_id)
        ? tplMaps.byPortableId.get(incoming.portable_id) : undefined;

      let plan;
      if (local) {
        const localEntries = (local.problems || []).map((e) => ({
          problem_portable_id: localSlugToPortableId(e.problem_id, byPortableId, bySlug),
          points: e.points ?? null, order: e.order
        }));
        const localHash = canonicalTemplateHashOf(local, localEntries);
        plan = resolveTemplateAction({
          base, local, localHash, incomingHash, parentHash, override, templateTakenSlugs
        });
      } else if (override === "skip") {
        plan = { ...base, action: "skip", target_slug: incoming?.slug, reason: "skipped" };
      } else {
        plan = { ...base, action: "create", target_slug: incoming?.slug, reason: "new" };
      }
      plan.entries = refResults;
      templates.push(plan);
    }

    const summary = summarize(problems, templates);
    return { problems, templates, summary };
  }

  // ---- POST /api/admin/bank-import-preview -----------------------------------
  // { bundle } -> the per-item plan + summary. NO writes.
  async function adminBankImportPreview(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const env = validateBundleEnvelope(body.bundle);
    if (!env.ok) throw httpError(400, env.code);
    const plan = await resolvePlan(env.bundle, null);
    return { ...plan, preview_token: bundleToken(env.bundle) };
  }

  // ---- POST /api/admin/bank-import-commit ------------------------------------
  // { bundle, overrides?, preview_token } -> applies the resolved plan. Problems
  // first (so template refs resolve), then templates. Idempotent re-run: an
  // already-applied item hash-matches and skips (§4 atomicity note).
  async function adminBankImportCommit(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const env = validateBundleEnvelope(body.bundle);
    if (!env.ok) throw httpError(400, env.code);
    // The preview_token pins the bundle the preview was computed against — a
    // changed bundle between preview and commit is refused (§3.5).
    if (body.preview_token && body.preview_token !== bundleToken(env.bundle)) {
      throw httpError(409, "bundle_changed");
    }
    const overrides = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
    const plan = await resolvePlan(env.bundle, overrides);

    const now = new Date().toISOString();
    const incomingById = new Map(env.bundle.problems.map((p) => [p.portable_id, p]));
    const portableToTargetSlug = new Map();
    const applied = { created: 0, updated: 0, forked: 0, skipped: 0, blocked: 0 };
    const problemResults = [];

    for (const item of plan.problems) {
      const incoming = incomingById.get(item.portable_id);
      try {
        const result = await applyProblem(item, incoming, overrides, now);
        if (result.target_slug && isValidPortableId(item.portable_id)) {
          portableToTargetSlug.set(item.portable_id, result.target_slug);
        }
        applied[result.bucket] = (applied[result.bucket] || 0) + 1;
        problemResults.push(result);
      } catch (error) {
        if (error?.statusCode === 409 && error?.message === "live_edit_confirmation_required") {
          applied.blocked += 1;
          problemResults.push({ portable_id: item.portable_id, action: "blocked", target_slug: null,
            reason: "live_edit_confirmation_required", extra: error.extra });
          continue;
        }
        throw error;
      }
    }

    const templateResults = [];
    const incomingTplById = new Map(env.bundle.templates.map((t) => [t.portable_id, t]));
    for (const item of plan.templates) {
      if (item.action === "blocked") {
        applied.blocked += 1;
        templateResults.push({ portable_id: item.portable_id, action: "blocked", target_slug: null,
          reason: item.reason, dangling: item.dangling });
        continue;
      }
      const incoming = incomingTplById.get(item.portable_id);
      const result = await applyTemplate(item, incoming, portableToTargetSlug, now);
      applied[result.bucket] = (applied[result.bucket] || 0) + 1;
      templateResults.push(result);
    }

    await writeAudit({
      action: "bank_import",
      counts: { problems: env.bundle.problems.length, templates: env.bundle.templates.length },
      applied
    }, adminActor(req, body), now);

    return { ok: true, applied, problems: problemResults, templates: templateResults };
  }

  // Apply one resolved problem through validateProblemInput + the guard-aware
  // save. create/update/fork/adopt/skip map onto the existing storage shape.
  async function applyProblem(item, incoming, overrides, now) {
    if (item.action === "skip" || item.action === "blocked") {
      return { portable_id: item.portable_id, action: item.action, target_slug: item.target_slug,
        reason: item.reason, bucket: "skipped" };
    }
    const targetSlug = item.target_slug;
    // Build the authoring payload from the bundle item, overriding the id with the
    // resolved target slug (fork lands at <id>-N). validateProblemInput re-checks
    // every bound — bundle JSON is never spread into storage.
    const payload = { ...incoming, id: targetSlug };
    const checked = validateProblemInput(payload);
    if (!checked.ok) throw httpErrorWith(400, "invalid_problem", { id: targetSlug, error: checked.error });

    // Live-reference guard reuse (§6.6): a hidden-test edit to a problem an OPEN
    // contest references demands the typed confirm, surfaced here as a 409 the
    // commit catches per item. confirm_live_edit override === the target slug.
    const existing = await problemRef(targetSlug).get();
    const current = existing.exists ? existing.data() : await getBankProblem(targetSlug);
    if ((item.action === "update" || item.action === "adopt") && current) {
      const hiddenChanged = JSON.stringify(current.hiddenTests || []) !== JSON.stringify(checked.problem.hiddenTests);
      if (hiddenChanged) {
        const refs = findProblemReferences(targetSlug, await problemReferenceUniverse());
        const openContests = refs.contests.filter((c) => c.status === "open");
        const confirm = overrides?.[`${item.portable_id}:confirm_live_edit`] || incoming?.confirm_live_edit;
        if (openContests.length && confirm !== targetSlug) {
          throw httpErrorWith(409, "live_edit_confirmation_required", {
            contests: openContests.map((c) => c.slug)
          });
        }
      }
    }

    // Provenance: a create/adopt keeps the bundle's portable_id (the travelling
    // identity). A FORK mints a FRESH portable id (it's a new lineage) and records
    // forked_from. parent_hash is stamped to this item's own content hash so a
    // re-export carries one-deep lineage.
    const isFork = item.action === "fork";
    const portableId = isFork ? mintPortableId() : item.portable_id;
    const origin = incoming?.origin && typeof incoming.origin === "object" && !isFork
      ? incoming.origin
      : { instance: instanceLabel, at: now };

    const doc = {
      ...checked.problem,
      portable_id: portableId,
      origin,
      parent_hash: canonicalProblemHash(checked.problem),
      ...(isFork && isValidPortableId(item.portable_id) ? { forked_from: item.portable_id } : {}),
      created_at: existing.exists ? (existing.data().created_at || now) : now,
      updated_at: now
    };
    await problemRef(targetSlug).set(doc);
    const bucket = isFork ? "forked" : (item.action === "create" ? "created" : "updated");
    return { portable_id: portableId, action: item.action, target_slug: targetSlug, reason: item.reason, bucket };
  }

  // Bounded reference universe for the live-edit guard (mirrors the problems
  // route): contest docs (limit 500) + templates (seeds merged via listTemplates).
  async function problemReferenceUniverse() {
    const [contestSnapshot, templates] = await Promise.all([
      getFirestore().collection(contestsCollection).limit(500).get(),
      listTemplates()
    ]);
    return { contests: contestSnapshot.docs.map((doc) => doc.data()), templates };
  }

  // Apply one resolved template through validateTemplateInput + requireKnownProblems
  // + create/update. The entries were already rewritten to the resolved LOCAL
  // slugs in resolvePlan; we re-resolve here against the committed problem targets
  // so a forked problem points at its fork.
  async function applyTemplate(item, incoming, portableToTargetSlug, now) {
    if (item.action === "skip") {
      return { portable_id: item.portable_id, action: "skip", target_slug: item.target_slug,
        reason: item.reason, bucket: "skipped" };
    }
    // Re-resolve refs against the freshly-committed problem target slugs (a fork
    // moved the slug). Fall back to the plan's pre-resolved entries.
    const entries = [];
    for (const entry of incoming.problems || []) {
      const pid = entry.problem_portable_id;
      let slug = isValidPortableId(pid) ? portableToTargetSlug.get(pid) : undefined;
      if (!slug && isValidPortableId(pid)) {
        const local = await getBankProblemByPortableId(pid);
        slug = local?.id;
      }
      if (slug) entries.push({ problem_id: slug, points: entry.points ?? null, order: entry.order });
    }

    const checked = validateTemplateInput({
      name: incoming.name, description: incoming.description ?? "",
      problems: entries, defaults: incoming.defaults
    });
    if (!checked.ok) throw httpErrorWith(400, "invalid_template", { slug: incoming.slug, error: checked.error });
    await requireKnownProblems(checked.template.problems);

    const isFork = item.action === "fork";
    const portableId = isFork ? mintPortableId() : item.portable_id;
    const origin = incoming?.origin && typeof incoming.origin === "object" && !isFork
      ? incoming.origin : { instance: instanceLabel, at: now };
    const parentHash = canonicalTemplateHashOf(
      { name: checked.template.name, description: checked.template.description, defaults: checked.template.defaults },
      checked.template.problems.map((e) => ({
        problem_portable_id: portableToTargetSlug.size ? reversePortableFor(e.problem_id, portableToTargetSlug) : null,
        points: e.points ?? null, order: e.order
      }))
    );
    const provenance = { portable_id: portableId, origin, parent_hash: parentHash,
      ...(isFork && isValidPortableId(item.portable_id) ? { forked_from: item.portable_id } : {}) };

    if (item.action === "create" || isFork) {
      const created = await createTemplateDoc({ ...checked.template, ...provenance });
      return { portable_id: portableId, action: isFork ? "fork" : "create", target_slug: created.slug,
        reason: item.reason, bucket: isFork ? "forked" : "created" };
    }
    // update in place (preserve slug + created_at; a rename never re-slugs).
    const existing = await getTemplate(item.target_slug);
    const itemDoc = {
      slug: existing.slug, ...checked.template, ...provenance,
      archived: Boolean(existing.archived),
      created_at: existing.created_at || now, updated_at: now
    };
    await templateRef(itemDoc.slug).set(itemDoc);
    return { portable_id: portableId, action: "update", target_slug: itemDoc.slug,
      reason: item.reason, bucket: "updated" };
  }

  // Look up a local bank problem doc by portable_id (small bounded scan). Used by
  // template ref re-resolution at commit when the referenced problem was already
  // local (skip/update, not in portableToTargetSlug).
  async function getBankProblemByPortableId(portableId) {
    const snapshot = await getFirestore().collection(problemsCollection).limit(problemsQueryLimit).get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data?.portable_id === portableId) return data;
    }
    return null;
  }

  return {
    adminBankExport,
    adminBankImportPreview,
    adminBankImportCommit
  };
}

// ---- small pure helpers (module scope; no ctx) -------------------------------

// Template content hash over portable refs (bulkIo.canonicalTemplateHash key-
// sorts + sha256s). Thin combinator so the route can pass a doc + its portable-
// ref entries directly.
function canonicalTemplateHashOf(doc, entries) {
  return canonicalTemplateHash({
    name: doc?.name, description: doc?.description, defaults: doc?.defaults, entries
  });
}

// Resolve a local template problem entry's slug back to a portable id using the
// local maps (best-effort; un-keyed local problems contribute null and so will
// differ from a bundle that DOES carry the portable id — a conservative "differs"
// that forks, never a silent dedup).
function localSlugToPortableId(slug, byPortableId, bySlug) {
  const doc = bySlug.get(slug);
  if (doc && isValidPortableId(doc.portable_id)) return doc.portable_id;
  return null;
}

// During commit's parent_hash stamping we only have target slugs; reverse them to
// the portable id we just landed (best-effort — used only for the stored
// parent_hash breadcrumb, never a guard input).
function reversePortableFor(slug, portableToTargetSlug) {
  for (const [pid, target] of portableToTargetSlug.entries()) {
    if (target === slug) return pid;
  }
  return null;
}

// The template A/B/C/D action (mirrors resolveProblem but for the template's own
// identity). Fork mints a fresh slug via the writer's -2/-3 loop downstream; the
// resolver only proposes the action + a base slug.
function resolveTemplateAction({ base, local, localHash, incomingHash, parentHash, override, templateTakenSlugs }) {
  if (override && ["skip", "update", "create", "fork", "adopt"].includes(override)) {
    if (override === "skip") return { ...base, action: "skip", target_slug: local.slug, reason: "override_skip" };
    if (override === "update" || override === "adopt") {
      return { ...base, action: "update", target_slug: local.slug, reason: "override_update" };
    }
    return { ...base, action: "fork", target_slug: local.slug, reason: "override_fork" };
  }
  if (localHash === incomingHash) return { ...base, action: "skip", target_slug: local.slug, reason: "identical" };
  if (localHash === parentHash) {
    return { ...base, action: "update", target_slug: local.slug, reason: "local_unchanged_since_export" };
  }
  return { ...base, action: "fork", target_slug: local.slug, reason: "divergent" };
}

function summarize(problems, templates) {
  const summary = { created: 0, unchanged: 0, updated: 0, forked: 0, blocked: 0 };
  for (const item of [...problems, ...templates]) {
    if (item.action === "create" || item.action === "adopt") summary.created += 1;
    else if (item.action === "skip") summary.unchanged += 1;
    else if (item.action === "update") summary.updated += 1;
    else if (item.action === "fork") summary.forked += 1;
    else if (item.action === "blocked") summary.blocked += 1;
  }
  return summary;
}

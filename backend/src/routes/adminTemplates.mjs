// backend/src/routes/adminTemplates.mjs — the proctor-template admin CRUD route
// domain as a FACTORY (decomp B2, plan §A2/§A8). makeAdminTemplatesRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the seven
// admin template route handlers + the template-block helpers it OWNS
// (templateRef / requireKnownProblems / createTemplateDoc / bankProblemPoints).
// handler.mjs instantiates this at module scope and destructures the route
// handlers into the SAME names the dispatch table calls, so the dispatch lines
// stay byte-identical (canaryIsolation text-scans them).
//
// Every route handler is AUTH-FIRST: requireAdmin(req) is the first statement
// (routesAuthLint pins this).
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore / makeInvigilatorRoutes:
// templates.test.mjs imports the handler with a ?templates buster and swaps the
// fake Firestore via __setClientsForTest — getFirestore is therefore taken as a
// GETTER so the swap propagates (the live handle is never captured by value).
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Everything stateful or env-captured (the live Firestore
// getter, collection names, query caps, the template-domain store/validation
// fns, slugify, the bank-problem reader, the shared isAlreadyExists helper, and
// the http transport helpers) arrives through ctx — nothing is imported here, so
// the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAdminTemplatesRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    badRequest,
    requireFields,
    httpError,
    httpErrorWith,
    // collection names (captured at handler load, per ?buster instance) + caps
    templatesCollection,
    problemsCollection,
    problemsQueryLimit,
    // template + problem domain fns / constants
    getTemplate,
    listTemplates,
    validateTemplateInput,
    structuredCloneTemplate,
    SEED_TEMPLATES,
    TEMPLATE_BOUNDS,
    slugify,
    getBankProblem,
    // shared handler-resident helper (single source — stays in handler.mjs)
    isAlreadyExists
  } = ctx;

  // ---- S-I §1.1/§2: proctor templates (admin CRUD) -----------------------------
  // Thin glue over src/templates.mjs (validation + seed shadowing live there).
  // Slug rules are the contest rules verbatim (slugify + -2 suffix, atomic
  // .create() decides ownership); SEED slugs are skipped at create so a new
  // template can never silently shadow the system-check preset.

  function templateRef(slug) {
    return getFirestore().collection(templatesCollection).doc(slug);
  }

  const TEMPLATE_SLUG_COLLISION_LIMIT = 50;

  // Every template problem entry must reference an EXISTING bank problem at save
  // time. Drafts are fine in a template (spec §1.1) — instantiation re-validates
  // published — so this reads through getBankProblem, never getProblem.
  async function requireKnownProblems(entries) {
    const unknown = [];
    for (const entry of entries) {
      if (!(await getBankProblem(entry.problem_id))) unknown.push(entry.problem_id);
    }
    if (unknown.length) throw httpErrorWith(400, "unknown_problems", { problems: unknown });
  }

  async function createTemplateDoc(template) {
    const baseSlug = slugify(template.name);
    if (!baseSlug) throw httpError(400, "name must contain letters or digits");
    const now = new Date().toISOString();
    for (let n = 1; n <= TEMPLATE_SLUG_COLLISION_LIMIT; n++) {
      const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
      if (Object.hasOwn(SEED_TEMPLATES, slug)) continue; // presets keep their slug
      const item = { slug, ...template, archived: false, created_at: now, updated_at: now };
      try {
        await templateRef(slug).create(item);
        return item;
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
    throw httpError(409, "slug_collision_limit");
  }

  // points per bank problem id for the list totals: one bounded collection read;
  // per-id getBankProblem fallback catches seed problems (e.g. sum-two).
  async function bankProblemPoints() {
    const points = new Map();
    const snapshot = await getFirestore().collection(problemsCollection).limit(problemsQueryLimit).get();
    for (const doc of snapshot.docs) {
      const p = doc.data();
      points.set(p.id, p.points ?? 100);
    }
    return {
      async effectiveFor(entry) {
        if (entry.points !== null && entry.points !== undefined) return entry.points;
        if (points.has(entry.problem_id)) return points.get(entry.problem_id);
        const fallback = await getBankProblem(entry.problem_id);
        const value = fallback ? (fallback.points ?? 100) : 0; // dangling ref counts 0
        points.set(entry.problem_id, value);
        return value;
      }
    };
  }

  async function adminListTemplates(req) {
    requireAdmin(req);
    const [templates, bank] = await Promise.all([listTemplates(), bankProblemPoints()]);
    const rows = [];
    for (const template of templates) {
      const entries = template.problems || [];
      let totalPoints = 0;
      for (const entry of entries) totalPoints += await bank.effectiveFor(entry);
      rows.push({
        slug: template.slug,
        name: template.name,
        archived: Boolean(template.archived),
        preset: Boolean(template.preset),
        problem_count: entries.length,
        total_points: totalPoints,
        updated_at: template.updated_at || ""
      });
    }
    return { templates: rows };
  }

  async function adminGetTemplate(req) {
    requireAdmin(req);
    const template = await getTemplate(req.query?.slug);
    if (!template) throw httpError(404, "template_not_found");
    return { template };
  }

  async function adminCreateTemplate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const checked = validateTemplateInput(body);
    if (!checked.ok) return badRequest(checked.error);
    await requireKnownProblems(checked.template.problems);
    return { ok: true, template: await createTemplateDoc(checked.template) };
  }

  // Partial update. THE rule (same as contests): a rename NEVER re-slugs — the
  // slug is referenced from contest provenance the moment one instantiates.
  // Updating a seed slug MATERIALIZES a shadow doc (customize-the-preset flow).
  async function adminUpdateTemplate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    const existing = await getTemplate(body.slug);
    if (!existing) throw httpError(404, "template_not_found");
    const merged = {
      name: body.name !== undefined ? body.name : existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      problems: body.problems !== undefined ? body.problems : existing.problems,
      defaults: {
        ...existing.defaults,
        ...(body.defaults && typeof body.defaults === "object" && !Array.isArray(body.defaults) ? body.defaults : {})
      }
    };
    const checked = validateTemplateInput(merged);
    if (!checked.ok) return badRequest(checked.error);
    if (body.problems !== undefined) await requireKnownProblems(checked.template.problems);
    const now = new Date().toISOString();
    const item = {
      slug: existing.slug,
      ...checked.template,
      archived: Boolean(existing.archived),
      created_at: existing.created_at || now,
      updated_at: now
    };
    await templateRef(item.slug).set(item);
    return { ok: true, template: item };
  }

  // Archived templates disappear from the instantiate picker but stay listed
  // behind the UI toggle. Archiving a seed materializes its shadow doc too.
  async function adminArchiveTemplate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    if (typeof body.archived !== "boolean") return badRequest("archived must be a boolean");
    const existing = await getTemplate(body.slug);
    if (!existing) throw httpError(404, "template_not_found");
    const now = new Date().toISOString();
    const { preset: _preset, ...rest } = existing;
    const item = { ...rest, archived: body.archived, created_at: existing.created_at || now, updated_at: now };
    await templateRef(item.slug).set(item);
    return { ok: true, template: item };
  }

  // Clone verb = the §1.4 snapshot copy onto a NEW template doc: deep copy of
  // problems + defaults, fresh slug from the (default "Copy of …") name, fresh
  // timestamps, archived reset.
  async function adminCloneTemplate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    const existing = await getTemplate(body.slug);
    if (!existing) throw httpError(404, "template_not_found");
    const name = (String(body.name ?? "").trim() || `Copy of ${existing.name}`).slice(0, TEMPLATE_BOUNDS.NAME_MAX);
    const copy = structuredCloneTemplate(existing);
    const checked = validateTemplateInput({
      name, description: copy.description, problems: copy.problems, defaults: copy.defaults
    });
    if (!checked.ok) return badRequest(checked.error);
    return { ok: true, template: await createTemplateDoc(checked.template) };
  }

  // Hard delete (FIX-B2 #58): permanently removes an author-owned template doc.
  // Archive is the soft-delete (the picker hides it but it stays listed); this is
  // the explicit "remove it for good" verb the Templates tab needs. A BARE seed
  // preset (no shadow doc — getTemplate returns preset:true) cannot be deleted —
  // it has no doc and would just reappear in the list; deleting a MATERIALIZED
  // shadow doc is allowed and simply restores the preset to its original form.
  async function adminDeleteTemplate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    const existing = await getTemplate(body.slug);
    if (!existing) throw httpError(404, "template_not_found");
    if (existing.preset) throw httpError(400, "template_preset_undeletable");
    await templateRef(existing.slug).delete();
    return { ok: true };
  }

  return {
    // route handlers (auth-first — routesAuthLint guards this); names match the
    // dispatch table exactly so handler.mjs's dispatch lines stay byte-identical.
    adminListTemplates,
    adminGetTemplate,
    adminCreateTemplate,
    adminUpdateTemplate,
    adminArchiveTemplate,
    adminCloneTemplate,
    adminDeleteTemplate,
    // template-block helpers it owns (currently used only by these routes; kept
    // single-source here in case future resident code needs them via ctx)
    templateRef,
    requireKnownProblems,
    createTemplateDoc,
    bankProblemPoints
  };
}

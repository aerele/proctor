// backend/src/problems.mjs
// S4: the problem BANK. Problems are authored into Firestore via the admin
// console; built-in SEED problems remain as a zero-config fallback so dev/demo/
// tests work with an empty collection. getProblem(id) is THE read interface for
// the exec endpoints + start payload — async + Firestore-backed now, same name
// and problem shape as Slice 1 (camelCase fields the exec handlers already read).
//
// NOTE: verify language_ids against the live instance via GET /languages before
// a real run; these are the common Judge0 CE ids.
export const LANGUAGE_IDS = { python: 71, cpp: 54, java: 62, javascript: 63 };

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_IDS);

// Authoring bounds. CPU/memory stay inside the Judge0 CE hard maxima (design
// §11) so an authored limit is never silently clamped by the engine. Hidden
// tests cap at 50 — the adapter already chunks batches to <=20 per request.
export const PROBLEM_BOUNDS = {
  ID_PATTERN: /^[a-z0-9][a-z0-9-]{0,63}$/,
  TITLE_MAX: 200,
  STATEMENT_MAX: 20000,
  TEST_TEXT_MAX: 10000,
  SAMPLE_TESTS_MAX: 10,
  HIDDEN_TESTS_MAX: 50,
  CPU_MIN: 0.5,
  CPU_MAX: 15,
  MEMORY_MIN: 16000,
  MEMORY_MAX: 512000,
  POINTS_MAX: 1000,
  // S-I §1.2 (vision §2.5): free-form bank tags for the admin picker/filter.
  TAGS_MAX: 10,
  TAG_PATTERN: /^[a-z0-9-]{1,30}$/
};

const SCORING_MODES = ["per_test", "all_or_nothing"];
const PROBLEM_STATUSES = ["draft", "published"];

// Slice 1's config problem, now in the seed-bank shape (status/points/scoring
// added). A Firestore doc with the same id SHADOWS this seed entirely.
const SEED_PROBLEMS = {
  "sum-two": {
    id: "sum-two",
    title: "Sum of Two Numbers",
    statement: "Read two integers a and b on one line separated by a space. Print a + b.",
    languages: ["python", "cpp", "java", "javascript"],
    cpuTimeLimit: 5, memoryLimit: 128000,
    points: 100, scoring: "per_test", status: "published",
    sampleTests: [
      { input: "2 3\n", expected: "5" },
      { input: "10 20\n", expected: "30" }
    ],
    hiddenTests: [
      { input: "0 0\n", expected: "0" },
      { input: "-5 5\n", expected: "0" },
      { input: "1000000 1\n", expected: "1000001" },
      { input: "-100 -200\n", expected: "-300" }
    ]
  }
};

export function isValidProblemId(id) {
  return PROBLEM_BOUNDS.ID_PATTERN.test(String(id || ""));
}

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate to problem reads too.
// Unconfigured (pure unit tests) -> seeds only.
let store = null;
export function configureProblemStore({ getFirestore, collection }) {
  store = { getFirestore, collection };
}

// THE candidate/exec read path. Published problems only:
//   - invalid id shape -> null BEFORE any Firestore doc path is built
//   - a bank doc OWNS its id: published -> served, draft -> null (hides any seed)
//   - no doc -> built-in seed fallback (own keys only, never prototype members)
export async function getProblem(id) {
  const key = String(id || "");
  if (!isValidProblemId(key)) return null;
  if (store) {
    const doc = await store.getFirestore().collection(store.collection).doc(key).get();
    if (doc.exists) {
      const problem = doc.data();
      return problem?.status === "published" ? problem : null;
    }
  }
  const seed = Object.hasOwn(SEED_PROBLEMS, key) ? SEED_PROBLEMS[key] : null;
  return seed && seed.status === "published" ? seed : null;
}

// S-I: the ADMIN/guard read path — doc-or-seed, ANY status. Templates may
// reference drafts and the live-reference guard must see draft docs, so this
// deliberately skips getProblem's published-only filter. NEVER candidate-facing.
export async function getBankProblem(id) {
  const key = String(id || "");
  if (!isValidProblemId(key)) return null;
  if (store) {
    const doc = await store.getFirestore().collection(store.collection).doc(key).get();
    if (doc.exists) return doc.data();
  }
  return Object.hasOwn(SEED_PROBLEMS, key) ? SEED_PROBLEMS[key] : null;
}

// Submit-time scoring (stored on the submission + returned with the verdict).
// per_test (default): floor(points * passed/total). all_or_nothing: full
// points only when every hidden test passed.
export function scoreSubmission(problem, passedCount, total) {
  const points = Number.isFinite(problem?.points) ? problem.points : 100;
  const mode = problem?.scoring === "all_or_nothing" ? "all_or_nothing" : "per_test";
  if (!total) return 0;
  if (mode === "all_or_nothing") return passedCount === total ? points : 0;
  return Math.floor((points * passedCount) / total);
}

function invalid(error) {
  return { ok: false, error };
}

function cleanTests(raw, max, label) {
  if (!Array.isArray(raw) || raw.length < 1) return invalid(`${label} must be a non-empty array`);
  if (raw.length > max) return invalid(`${label}: max ${max} tests`);
  const tests = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || item.input === undefined || item.expected === undefined) {
      return invalid(`${label}[${index}] must be an object with input and expected`);
    }
    const input = String(item.input);
    const expected = String(item.expected);
    if (input.length > PROBLEM_BOUNDS.TEST_TEXT_MAX || expected.length > PROBLEM_BOUNDS.TEST_TEXT_MAX) {
      return invalid(`${label}[${index}]: input/expected max ${PROBLEM_BOUNDS.TEST_TEXT_MAX} chars`);
    }
    tests.push({ input, expected });
  }
  return { ok: true, tests };
}

// Validate + NORMALIZE an authoring payload into a brand-new allow-listed
// problem object — client input is never spread into storage (same hardening
// rule as the editor-events ingest). Returns {ok:true, problem}|{ok:false, error}.
export function validateProblemInput(body) {
  const id = String(body?.id || "").trim();
  if (!isValidProblemId(id)) return invalid("id must be 1-64 lowercase letters/digits/hyphens (starting with a letter or digit)");

  const title = String(body?.title || "").trim();
  if (!title) return invalid("title is required");
  if (title.length > PROBLEM_BOUNDS.TITLE_MAX) return invalid(`title: max ${PROBLEM_BOUNDS.TITLE_MAX} chars`);

  const statement = String(body?.statement || "");
  if (!statement.trim()) return invalid("statement is required");
  if (statement.length > PROBLEM_BOUNDS.STATEMENT_MAX) return invalid(`statement: max ${PROBLEM_BOUNDS.STATEMENT_MAX} chars`);

  const rawLanguages = Array.isArray(body?.languages) ? body.languages.map(String) : [];
  const languages = [...new Set(rawLanguages)];
  if (!languages.length) return invalid("languages must be a non-empty array");
  for (const lang of languages) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) return invalid(`unsupported language: ${lang}`);
  }

  const cpuTimeLimit = Number(body?.cpuTimeLimit);
  if (!Number.isFinite(cpuTimeLimit) || cpuTimeLimit < PROBLEM_BOUNDS.CPU_MIN || cpuTimeLimit > PROBLEM_BOUNDS.CPU_MAX) {
    return invalid(`cpuTimeLimit must be ${PROBLEM_BOUNDS.CPU_MIN}-${PROBLEM_BOUNDS.CPU_MAX} seconds`);
  }
  const memoryLimit = Number(body?.memoryLimit);
  if (!Number.isInteger(memoryLimit) || memoryLimit < PROBLEM_BOUNDS.MEMORY_MIN || memoryLimit > PROBLEM_BOUNDS.MEMORY_MAX) {
    return invalid(`memoryLimit must be an integer ${PROBLEM_BOUNDS.MEMORY_MIN}-${PROBLEM_BOUNDS.MEMORY_MAX} KB`);
  }

  const points = body?.points === undefined ? 100 : Number(body.points);
  if (!Number.isInteger(points) || points < 0 || points > PROBLEM_BOUNDS.POINTS_MAX) {
    return invalid(`points must be an integer 0-${PROBLEM_BOUNDS.POINTS_MAX}`);
  }
  const scoring = body?.scoring === undefined ? "per_test" : String(body.scoring);
  if (!SCORING_MODES.includes(scoring)) return invalid(`scoring must be one of ${SCORING_MODES.join(", ")}`);
  const status = body?.status === undefined ? "draft" : String(body.status);
  if (!PROBLEM_STATUSES.includes(status)) return invalid(`status must be one of ${PROBLEM_STATUSES.join(", ")}`);

  const samples = cleanTests(body?.sampleTests, PROBLEM_BOUNDS.SAMPLE_TESTS_MAX, "sampleTests");
  if (!samples.ok) return samples;
  const hidden = cleanTests(body?.hiddenTests, PROBLEM_BOUNDS.HIDDEN_TESTS_MAX, "hiddenTests");
  if (!hidden.ok) return hidden;

  // S-I §1.2: optional tags — trimmed, lowercased, deduped; bounded charset/
  // length/count so the admin filter UI never renders unbounded garbage.
  let tags = [];
  if (body?.tags !== undefined) {
    if (!Array.isArray(body.tags)) return invalid("tags must be an array");
    tags = [...new Set(body.tags.map((tag) => String(tag).trim().toLowerCase()))];
    if (tags.length > PROBLEM_BOUNDS.TAGS_MAX) return invalid(`tags: max ${PROBLEM_BOUNDS.TAGS_MAX}`);
    for (const tag of tags) {
      if (!PROBLEM_BOUNDS.TAG_PATTERN.test(tag)) {
        return invalid("tags must be 1-30 chars of lowercase letters/digits/hyphens");
      }
    }
  }

  // F12.2: optional per-language STARTER STUBS. An object keyed by SUPPORTED
  // language; each value is the prefilled starter code (a string). Absent is
  // fine — a problem without stubs is byte-identical to today (the field is
  // omitted, never stored as {}). A bad shape is a hard 400, not silent drop.
  const stubsResult = cleanStubs(body?.stubs);
  if (!stubsResult.ok) return stubsResult;

  return {
    ok: true,
    problem: {
      id, title, statement, languages,
      cpuTimeLimit, memoryLimit, points, scoring, status, tags,
      sampleTests: samples.tests, hiddenTests: hidden.tests,
      ...(stubsResult.stubs ? { stubs: stubsResult.stubs } : {})
    }
  };
}

// F12.2: validate + normalize the optional per-language stub map. Allow-listed
// keys (subset of SUPPORTED_LANGUAGES), string values bounded by STATEMENT_MAX.
// Returns {ok:true, stubs} where stubs is undefined when absent/empty (so the
// field is omitted from storage and back-compat holds byte-for-byte), or a
// fresh object built key-by-key (client input is never spread into storage).
export function cleanStubs(raw) {
  if (raw === undefined || raw === null) return { ok: true, stubs: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return invalid("stubs must be an object keyed by language");
  const stubs = {};
  for (const [language, value] of Object.entries(raw)) {
    if (!SUPPORTED_LANGUAGES.includes(language)) return invalid(`stubs: unsupported language ${language}`);
    if (typeof value !== "string") return invalid(`stubs.${language} must be a string`);
    if (value.length > PROBLEM_BOUNDS.STATEMENT_MAX) {
      return invalid(`stubs.${language}: max ${PROBLEM_BOUNDS.STATEMENT_MAX} chars`);
    }
    stubs[language] = value;
  }
  // An empty object carries no information — treat it as absent so a problem
  // authored with an all-blank stub map stays back-compat (no `stubs` field).
  return { ok: true, stubs: Object.keys(stubs).length ? stubs : undefined };
}

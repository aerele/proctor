// S-D: pure logic for the Contests tab + the global contest selector.
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md
//   §2.7  — URLs are DERIVED (contest_url is dead): candidate /?contest={slug},
//           invigilator /invigilator?contest={slug}&key={invigilator_key}
//   §5 A1 — selector scopes every tab; URL-param per-tab so two browser tabs
//           can run two parallel drives
//   §7 S-D — default selection: the single open contest if exactly one, else
//           explicit choice
import type { ContestStatus, ContestSummary } from "../types";

// ---- derived URLs (vision §2.7) ---------------------------------------------

export function candidateUrlFor(origin: string, slug: string): string {
  return `${origin}/?contest=${encodeURIComponent(slug)}`;
}

export function invigilatorUrlFor(origin: string, slug: string, key: string | null): string {
  const base = `${origin}/invigilator?contest=${encodeURIComponent(slug)}`;
  return key ? `${base}&key=${encodeURIComponent(key)}` : base;
}

// ---- list presentation ---------------------------------------------------------

/** Status -> chip tone token (the component maps tones to Tailwind classes). */
export function contestStatusTone(status: ContestStatus): "open" | "draft" | "archived" {
  if (status === "open") return "open";
  if (status === "archived") return "archived";
  return "draft";
}

/** Compact human window label for the contests list. */
export function contestWindowLabel(startAt: string | null, endAt: string | null): string {
  if (!startAt && !endAt) return "no window set";
  const fmt = (iso: string) => new Date(iso).toLocaleString();
  if (startAt && endAt) return `${fmt(startAt)} → ${fmt(endAt)}`;
  if (startAt) return `${fmt(startAt)} → (no end)`;
  return `(no start) → ${fmt(endAt as string)}`;
}

/** Ordered problems count — legacy synth rows count their single problem_id. */
export function contestProblemsCount(contest: ContestSummary): number {
  if (Array.isArray(contest.problems)) return contest.problems.length;
  return contest.problem_id ? 1 : 0;
}

// Open first (live ops), then draft (being built), then archived; the legacy
// row sorts after real contests within its status group; newest first inside
// a group (mirrors the backend list order), slug as the final tiebreak.
const STATUS_ORDER: Record<ContestStatus, number> = { open: 0, draft: 1, archived: 2 };

export function sortContestsForList(contests: ContestSummary[]): ContestSummary[] {
  return [...contests].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)
    || Number(a.legacy) - Number(b.legacy)
    || String(b.created_at || "").localeCompare(String(a.created_at || ""))
    || a.slug.localeCompare(b.slug)
  );
}

// ---- selector ---------------------------------------------------------------------

/**
 * The selector's initial selection: an explicit URL param ALWAYS wins (even an
 * unknown slug — admin GETs filter literally and render empty lists, F9 D10);
 * with no param, the single OPEN contest (incl. legacy) auto-selects; anything
 * else stays "" = explicit choice (All contests).
 */
export function defaultContestSelection(contests: ContestSummary[], urlParam: string): string {
  const param = urlParam.trim();
  if (param) return param;
  const open = contests.filter((contest) => contest.status === "open");
  return open.length === 1 ? open[0].slug : "";
}

/**
 * The tab URL's search string with the contest param set/replaced/removed —
 * the per-tab persistence seam (two browser tabs = two independent drives).
 * Returns "" when no params remain so the URL stays clean.
 */
export function searchWithContestParam(search: string, slug: string): string {
  const params = new URLSearchParams(search);
  if (slug) params.set("contest", slug);
  else params.delete("contest");
  const text = params.toString();
  return text ? `?${text}` : "";
}

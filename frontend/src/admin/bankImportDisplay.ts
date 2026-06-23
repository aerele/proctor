// frontend/src/admin/bankImportDisplay.ts
// BANK-1 (F11) UI — the PURE display mapping for the import preview/commit plan.
// Kept out of BankImportDialog.tsx so the action→badge text/tone and the legal
// per-row override set are unit-testable without rendering. Mirrors the backend
// resolver actions (bulkIo.mjs PROBLEM_ACTIONS + the template resolver) and the
// preview plan shape (routes/adminBankIo.mjs §3.5).
import type {
  BankImportAction,
  BankImportProblemItem,
  BankImportSummary,
  BankImportTemplateItem
} from "../types";

// The override values the backend honors per portable_id (commit `overrides`
// map). "blocked" is never an override the admin picks — it is a resolver
// outcome (dangling refs / live-edit / fork-slug-exhausted).
export type BankOverrideAction = "create" | "update" | "fork" | "skip" | "adopt";

// A badge descriptor for a planned/applied disposition: the human label and a
// tone the dialog maps to Tailwind classes (kept symbolic so the test asserts
// semantics, not class strings).
export type BankBadge = { label: string; tone: "new" | "skip" | "update" | "fork" | "blocked" };

const PROBLEM_BADGES: Record<BankImportAction, BankBadge> = {
  create: { label: "Create", tone: "new" },
  adopt: { label: "Adopt", tone: "new" },
  skip: { label: "Unchanged", tone: "skip" },
  update: { label: "Update", tone: "update" },
  fork: { label: "Fork → -2", tone: "fork" },
  blocked: { label: "Blocked", tone: "blocked" }
};

/** The badge for a problem/template row. `forkTarget` (the resolved fork slug)
 *  refines the fork label so the admin sees exactly where it lands. */
export function badgeForAction(action: BankImportAction, forkTarget?: string | null): BankBadge {
  const base = PROBLEM_BADGES[action] ?? PROBLEM_BADGES.blocked;
  if (action === "fork" && forkTarget) {
    return { ...base, label: `Fork → ${forkTarget}` };
  }
  return base;
}

/** A short, plain-English reason for the row (the backend reason code → prose),
 *  falling back to the raw code so an unknown future reason is never hidden. */
export function reasonText(reason: string): string {
  switch (reason) {
    case "new": return "New here — will be created.";
    case "identical": return "Identical to the local copy — skipped (deduped).";
    case "local_unchanged_since_export": return "Local copy untouched since export — updated in place.";
    case "divergent": return "Both sides changed since the fork — imported as a new copy (nothing overwritten).";
    case "legacy_collision": return "A local item shares this slug but has no portable identity — kept both.";
    case "slug_collision": return "A different local item already uses this slug — kept both.";
    case "dangling_problem_refs": return "References a problem not in this bundle and not on this instance.";
    case "fork_slug_exhausted": return "Could not find a free fork slug — blocked.";
    case "live_edit_confirmation_required": return "An OPEN contest references this problem — confirm the live edit to update.";
    case "override_skip": return "Skipped by your choice.";
    case "override_update": return "Updated by your choice.";
    case "override_fork": return "Forked by your choice.";
    case "adopt_legacy": return "Adopting the local un-keyed copy (stamping the portable id + updating).";
    case "skipped": return "Skipped.";
    default: return reason;
  }
}

// The legal per-row overrides depend on WHY a row landed where it did. We infer
// the situation from the resolver's action + reason (the backend doesn't ship an
// explicit "case" tag, but the reason codes are unambiguous):
//
//  - create (reason "new")           → admin may instead skip.
//  - skip   (reason "identical")     → a true no-op; admin may force update/fork.
//  - update (local unchanged)        → admin may downgrade to skip or escalate to fork.
//  - fork   (divergent / collision)  → admin may instead update (overwrite) or skip;
//                                       adopt only when it's a LEGACY un-keyed collision.
//  - blocked                         → only the live-edit case is admin-resolvable
//                                       (confirm), handled separately; dangling/exhausted
//                                       offer no override.

/** Legal override actions for a problem row (empty ⇒ the row is not overridable). */
export function legalProblemOverrides(item: BankImportProblemItem): BankOverrideAction[] {
  switch (item.action) {
    case "create":
      return ["create", "skip"];
    case "skip":
      // identical round-trip: let the admin force a write if they really mean to.
      return ["skip", "update", "fork"];
    case "update":
      return ["update", "skip", "fork"];
    case "fork":
      if (item.reason === "legacy_collision") {
        // un-keyed local doc: adopt (take it over) is the extra one-click path.
        return ["fork", "adopt", "skip"];
      }
      return ["fork", "update", "skip"];
    case "adopt":
      return ["adopt", "skip"];
    case "blocked":
    default:
      return [];
  }
}

/** Legal override actions for a template row. Templates have the same A/B/C/D
 *  identity machine but no legacy "adopt" path (slugs are minted, not adopted). */
export function legalTemplateOverrides(item: BankImportTemplateItem): BankOverrideAction[] {
  switch (item.action) {
    case "create":
      return ["create", "skip"];
    case "skip":
      return ["skip", "update", "fork"];
    case "update":
      return ["update", "skip", "fork"];
    case "fork":
      return ["fork", "update", "skip"];
    case "blocked":
    default:
      // A dangling-ref block is only cleared by fixing the bundle / dropping the
      // entry — no per-row override resolves it, so Apply must stay disabled.
      return [];
  }
}

/** A template row that blocks Apply: a dangling-ref block with no override that
 *  can clear it. (Live-edit problem blocks are commit-time, not in the preview.) */
export function isHardBlocked(item: BankImportTemplateItem): boolean {
  return item.action === "blocked";
}

/** True when the whole plan has at least one unresolvable block (Apply disabled).
 *  A dangling template ref is the canonical case. */
export function planHasHardBlock(
  templates: BankImportTemplateItem[],
  overrides: Record<string, string>
): boolean {
  return templates.some((t) => isHardBlocked(t) && !overrides[t.portable_id]);
}

/** Human one-liner for the footer summary of a preview plan. */
export function summaryText(summary: BankImportSummary): string {
  return [
    `${summary.created} created`,
    `${summary.unchanged} unchanged`,
    `${summary.updated} updated`,
    `${summary.forked} forked`,
    `${summary.blocked} blocked`
  ].join(" · ");
}

/** Human label for a single override option in the per-row <select>. */
export function overrideLabel(action: BankOverrideAction): string {
  switch (action) {
    case "create": return "Create new";
    case "update": return "Update in place";
    case "fork": return "Keep both (fork)";
    case "skip": return "Skip";
    case "adopt": return "Adopt local";
  }
}

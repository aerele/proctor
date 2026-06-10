// F6.1-2 — pure selection-set helpers for the alerts console bulk select +
// bulk archive flow (App.tsx AlertsConsole). Selection is a Set of alert ids
// so it survives the 5 s auto-refresh; these helpers never mutate their input.
// Vitest-covered (alertSelection.test.ts).

import { candidateIdOf } from "./identity";

/** Toggle a single alert id in/out of the selection. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select-all over the CURRENTLY FILTERED list: union, keeping off-screen ids. */
export function addAllToSelection(selected: ReadonlySet<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.add(id);
  return next;
}

/** Drop ids from the selection (e.g. after they were archived). */
export function removeFromSelection(selected: ReadonlySet<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.delete(id);
  return next;
}

/** True when every visible id is selected (drives the select-all checkbox). */
export function isAllSelected(selected: ReadonlySet<string>, ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/** Unique candidate IDs behind the selected alerts, in list order — the
 * targets for bulk SESSION actions (approve/lock/...), not alert archiving.
 * (S-A: keeps its wire-era name; values resolve via candidateIdOf.) */
export function usernamesForSelection(
  alerts: Array<{ id: string; hackerrank_username: string; candidate_id?: string }>,
  selected: ReadonlySet<string>
): string[] {
  const usernames = new Set<string>();
  for (const alert of alerts) {
    if (selected.has(alert.id)) usernames.add(candidateIdOf(alert));
  }
  return [...usernames];
}

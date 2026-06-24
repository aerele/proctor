// frontend/src/admin/bulkSelect.ts
// LT-9: shared pure logic for the BANK-1 bulk-export "select all" header
// control, used by both ProblemBank (problem ids) and TemplatesPanel (template
// slugs). The components own the selection Set + the visible-row list; these
// helpers derive the header checkbox's tri-state and compute the next Set when
// the header is toggled. Kept dependency-free + framework-free so it's unit-
// testable in this jsdom-less harness (renderToStaticMarkup can't drive clicks).
//
// "Select all" operates over the VISIBLE/exportable set the caller passes in —
// the same ids/slugs the row checkboxes and the export action use — so the
// header always agrees with what export will send. (Both lists currently render
// their full fetched set unfiltered, so visible === all today; passing the
// rendered list keeps this correct if a filter is ever added.)

// Header checkbox state for a set of selectable keys:
//  - "none"          → unchecked        (no visible row selected)
//  - "all"           → checked          (every visible row selected)
//  - "indeterminate" → partial          (some but not all selected)
// An empty visible list is "none" (and the header is typically hidden anyway).
export type HeaderSelectState = "none" | "all" | "indeterminate";

export function headerSelectState(visibleKeys: readonly string[], selected: ReadonlySet<string>): HeaderSelectState {
  if (visibleKeys.length === 0) return "none";
  let selectedVisible = 0;
  for (const key of visibleKeys) {
    if (selected.has(key)) selectedVisible += 1;
  }
  if (selectedVisible === 0) return "none";
  if (selectedVisible === visibleKeys.length) return "all";
  return "indeterminate";
}

// Convenience flags for binding a DOM checkbox: `checked` (true only when ALL
// visible are selected) and `indeterminate` (true on a partial selection).
export function headerCheckboxFlags(visibleKeys: readonly string[], selected: ReadonlySet<string>): { checked: boolean; indeterminate: boolean } {
  const state = headerSelectState(visibleKeys, selected);
  return { checked: state === "all", indeterminate: state === "indeterminate" };
}

// Toggle-all from the header: if every visible key is already selected, clear
// them (deselect-all); otherwise add all visible keys (select-all). Selections
// for keys NOT in the visible set are preserved — important if a filter is later
// added so toggling the filtered view doesn't silently drop hidden selections.
export function toggleAllVisible(visibleKeys: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (headerSelectState(visibleKeys, selected) === "all") {
    for (const key of visibleKeys) next.delete(key);
  } else {
    for (const key of visibleKeys) next.add(key);
  }
  return next;
}

// Wave7-H: PURE-logic tests for the admin Data-lifecycle section helpers.
// The suite has no jsdom render harness, so the triple-gate enable logic and the
// retention-countdown formatting are extracted into pure functions tested here.
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.16 (export →
// triple-gated purge → tombstone), §2.9 (purge-survivor), §10.4 (export zips).
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  lifecyclePhase,
  purgeGateState,
  retentionStatus,
  type LifecycleContest
} from "./dataLifecycle";

function contest(over: Partial<LifecycleContest> = {}): LifecycleContest {
  return {
    slug: "kec-r1",
    status: "archived",
    legacy: false,
    last_export_at: null,
    selection_done_at: null,
    evidence_retention_days: 4,
    evidence_purged_at: null,
    db_purged_at: null,
    purged_at: null,
    ...over
  };
}

describe("purgeGateState — the triple-gate enable logic (mirrors evaluatePurgeGate)", () => {
  it("gate 1: disabled with no prior export, and names export as the next step", () => {
    const state = purgeGateState({ contest: contest({ last_export_at: null }), confirmed: true, typedSlug: "kec-r1" });
    expect(state.exportDone).toBe(false);
    expect(state.canConfirm).toBe(false); // can't even reach the confirm step
    expect(state.canPurge).toBe(false);
    expect(state.nextStep).toBe("export");
  });

  it("gate 2: export exists but the understand-checkbox is unchecked → confirm step is the blocker", () => {
    const state = purgeGateState({
      contest: contest({ last_export_at: "2026-06-01T00:00:00.000Z" }),
      confirmed: false,
      typedSlug: "kec-r1"
    });
    expect(state.exportDone).toBe(true);
    expect(state.canConfirm).toBe(true); // the confirm checkbox is now reachable
    expect(state.confirmed).toBe(false);
    expect(state.canPurge).toBe(false);
    expect(state.nextStep).toBe("confirm");
  });

  it("gate 3: confirmed but the typed slug does not match → slug step is the blocker", () => {
    const state = purgeGateState({
      contest: contest({ last_export_at: "2026-06-01T00:00:00.000Z" }),
      confirmed: true,
      typedSlug: "kec-r"
    });
    expect(state.slugMatches).toBe(false);
    expect(state.canPurge).toBe(false);
    expect(state.nextStep).toBe("slug");
  });

  it("all three gates pass → final Purge button enabled", () => {
    const state = purgeGateState({
      contest: contest({ last_export_at: "2026-06-01T00:00:00.000Z" }),
      confirmed: true,
      typedSlug: "kec-r1"
    });
    expect(state.exportDone).toBe(true);
    expect(state.confirmed).toBe(true);
    expect(state.slugMatches).toBe(true);
    expect(state.canPurge).toBe(true);
    expect(state.nextStep).toBe("ready");
  });

  it("typed slug is trimmed and case-sensitive (matches the server gate exactly)", () => {
    const base = { contest: contest({ last_export_at: "2026-06-01T00:00:00.000Z" }), confirmed: true };
    expect(purgeGateState({ ...base, typedSlug: "  kec-r1  " }).slugMatches).toBe(true);
    expect(purgeGateState({ ...base, typedSlug: "KEC-R1" }).slugMatches).toBe(false);
    expect(purgeGateState({ ...base, typedSlug: "" }).slugMatches).toBe(false);
  });

  it("an already-purged (tombstoned) contest reports purged and never re-enables the gate", () => {
    const state = purgeGateState({
      contest: contest({ purged_at: "2026-06-05T00:00:00.000Z", last_export_at: "2026-06-01T00:00:00.000Z" }),
      confirmed: true,
      typedSlug: "kec-r1"
    });
    expect(state.alreadyPurged).toBe(true);
    expect(state.canPurge).toBe(false);
    expect(state.nextStep).toBe("purged");
  });
});

describe("retentionStatus — selection-done + evidence countdown formatting", () => {
  const done = "2026-06-01T00:00:00.000Z";

  it("no selection_done_at → clock not started (the retention clock is human-triggered)", () => {
    const status = retentionStatus({ contest: contest({ selection_done_at: null }), now: done });
    expect(status.started).toBe(false);
    expect(status.purged).toBe(false);
    expect(status.label).toMatch(/not started/i);
  });

  it("mid-window → 'recordings auto-delete in N days' with the resolved delete date", () => {
    // 4-day window, sweep 1 day in: 3 days remain.
    const now = new Date(Date.parse(done) + 1 * DAY_MS).toISOString();
    const status = retentionStatus({ contest: contest({ selection_done_at: done, evidence_retention_days: 4 }), now });
    expect(status.started).toBe(true);
    expect(status.purged).toBe(false);
    expect(status.daysRemaining).toBe(3);
    expect(status.label).toMatch(/recordings auto-delete in 3 days/i);
    expect(status.deleteAt).toBe(new Date(Date.parse(done) + 4 * DAY_MS).toISOString());
  });

  it("singular day phrasing when exactly one day remains", () => {
    const now = new Date(Date.parse(done) + 3 * DAY_MS).toISOString();
    const status = retentionStatus({ contest: contest({ selection_done_at: done, evidence_retention_days: 4 }), now });
    expect(status.daysRemaining).toBe(1);
    expect(status.label).toMatch(/in 1 day\b/i);
  });

  it("partial final day rounds UP so the countdown never reads 0 before the sweep runs", () => {
    // 12 hours into the final day — still due "today-ish": ceil → 1 day, not 0.
    const now = new Date(Date.parse(done) + 3.5 * DAY_MS).toISOString();
    const status = retentionStatus({ contest: contest({ selection_done_at: done, evidence_retention_days: 4 }), now });
    expect(status.daysRemaining).toBe(1);
    expect(status.due).toBe(false);
  });

  it("past the window but not yet swept → due for deletion (sweep will catch it)", () => {
    const now = new Date(Date.parse(done) + 5 * DAY_MS).toISOString();
    const status = retentionStatus({ contest: contest({ selection_done_at: done, evidence_retention_days: 4 }), now });
    expect(status.started).toBe(true);
    expect(status.purged).toBe(false);
    expect(status.due).toBe(true);
    expect(status.daysRemaining).toBe(0);
    expect(status.label).toMatch(/due for deletion/i);
  });

  it("evidence already swept → 'evidence deleted' indicator wins over any countdown", () => {
    const status = retentionStatus({
      contest: contest({ selection_done_at: done, evidence_purged_at: "2026-06-06T00:00:00.000Z" }),
      now: "2026-06-10T00:00:00.000Z"
    });
    expect(status.purged).toBe(true);
    expect(status.label).toMatch(/evidence deleted/i);
  });

  it("garbage retention days falls back to the 4-day default", () => {
    const now = new Date(Date.parse(done) + 1 * DAY_MS).toISOString();
    const status = retentionStatus({
      contest: contest({ selection_done_at: done, evidence_retention_days: 0 }),
      now
    });
    expect(status.retentionDays).toBe(4);
    expect(status.daysRemaining).toBe(3);
  });
});

describe("lifecyclePhase — the derived lifecycle badge (vision §2.7 phase ladder)", () => {
  it("a live (open, windowed) contest reads Live", () => {
    const now = "2026-06-01T12:00:00.000Z";
    const phase = lifecyclePhase(
      contest({ status: "open", start_at: "2026-06-01T10:00:00.000Z", end_at: "2026-06-01T14:00:00.000Z" }),
      now
    );
    expect(phase.key).toBe("live");
  });

  it("an open contest before its window reads Scheduled", () => {
    const now = "2026-06-01T08:00:00.000Z";
    const phase = lifecyclePhase(
      contest({ status: "open", start_at: "2026-06-01T10:00:00.000Z", end_at: "2026-06-01T14:00:00.000Z" }),
      now
    );
    expect(phase.key).toBe("scheduled");
  });

  it("a draft reads Draft", () => {
    expect(lifecyclePhase(contest({ status: "draft" }), "2026-06-01T00:00:00.000Z").key).toBe("draft");
  });

  it("selection done (no purge yet) reads Selection done", () => {
    const phase = lifecyclePhase(
      contest({ status: "archived", selection_done_at: "2026-06-01T00:00:00.000Z" }),
      "2026-06-02T00:00:00.000Z"
    );
    expect(phase.key).toBe("selection_done");
  });

  it("evidence purged but DB intact reads Evidence purged", () => {
    const phase = lifecyclePhase(
      contest({ status: "archived", selection_done_at: "2026-06-01T00:00:00.000Z", evidence_purged_at: "2026-06-06T00:00:00.000Z" }),
      "2026-06-07T00:00:00.000Z"
    );
    expect(phase.key).toBe("evidence_purged");
  });

  it("DB purged (tombstoned) reads Purged and is flagged as a tombstone", () => {
    const phase = lifecyclePhase(
      contest({ status: "archived", purged_at: "2026-06-08T00:00:00.000Z", db_purged_at: "2026-06-08T00:00:00.000Z" }),
      "2026-06-09T00:00:00.000Z"
    );
    expect(phase.key).toBe("purged");
    expect(phase.tombstone).toBe(true);
  });

  it("purged takes priority over evidence_purged and selection_done", () => {
    const phase = lifecyclePhase(
      contest({
        status: "archived",
        selection_done_at: "2026-06-01T00:00:00.000Z",
        evidence_purged_at: "2026-06-06T00:00:00.000Z",
        purged_at: "2026-06-08T00:00:00.000Z"
      }),
      "2026-06-09T00:00:00.000Z"
    );
    expect(phase.key).toBe("purged");
  });
});

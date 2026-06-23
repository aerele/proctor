// frontend/src/candidate/drainGate.test.ts — release-blocker drain-gate logic.
// Covers the invariant: the candidate UI may claim "safe to exit / fully
// uploaded" ONLY when the recording buffer is provably empty (or fallback). Any
// pending-and-unflushed state must be a truthful "NOT saved" state that
// preserves the durable buffer — never a green checkmark.
import { describe, expect, it, vi } from "vitest";
import type { BufferMode, BufferStatus } from "../useProctorRecorder";
import { canShowSafeExit, drainBuffer, endPlanForDrain, type DrainRecorder } from "./drainGate";

const noSleep = () => Promise.resolve();

// A scriptable recorder fake matching the recorder-mocking style in the existing
// suites: getBufferStatus returns the next scripted snapshot per poll, and
// kickDrain is a spy so we can assert the drainer is woken.
function fakeRecorder(opts: {
  mode?: BufferMode;
  snapshots: BufferStatus[];
}): DrainRecorder & { kicks: number } {
  const snapshots = [...opts.snapshots];
  const rec = {
    kicks: 0,
    getBufferMode: () => opts.mode ?? "buffering",
    getBufferStatus: async () => snapshots.shift() ?? snapshots[snapshots.length - 1] ?? { mode: "buffering", pendingCount: 0, pendingBytes: 0 },
    kickDrain: () => {
      rec.kicks += 1;
    }
  };
  return rec;
}

const buffering = (pendingCount: number): BufferStatus => ({ mode: "buffering", pendingCount, pendingBytes: pendingCount * 1000 });

describe("drainBuffer — the end-of-test drain gate (Defect A)", () => {
  it("returns drained:true when the buffer reaches empty", async () => {
    const recorder = fakeRecorder({ snapshots: [buffering(3), buffering(1), buffering(0)] });
    const result = await drainBuffer(recorder, { getStatus: () => "ending_draining", sleep: noSleep });
    expect(result).toEqual({ drained: true, pending: 0 });
    expect(recorder.kicks).toBeGreaterThan(0); // it actually woke the drainer
  });

  it("returns drained:true immediately when the buffer is already empty at entry", async () => {
    const recorder = fakeRecorder({ snapshots: [buffering(0)] });
    const result = await drainBuffer(recorder, { getStatus: () => "ending_draining", sleep: noSleep });
    expect(result).toEqual({ drained: true, pending: 0 });
    expect(recorder.kicks).toBe(0); // no polling needed — never entered the loop
  });

  it("returns drained:false with the real pending count when status flips away mid-wait (chunks still pending)", async () => {
    // Two pending chunks every poll; status flips away after the first poll.
    const recorder = fakeRecorder({ snapshots: [buffering(2), buffering(2), buffering(2)] });
    let polls = 0;
    const getStatus = () => {
      polls += 1;
      // First read (loop entry) is "ending_draining"; after that the candidate's
      // resume click / a server flip moves status away while chunks still pend.
      return polls <= 1 ? "ending_draining" : "recording";
    };
    const result = await drainBuffer(recorder, { getStatus, sleep: noSleep });
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(2); // the TRUTH — not silently zeroed
  });

  it("treats fallback mode as the floor (drained:true) — no durable buffer to lose", async () => {
    const recorder = fakeRecorder({ mode: "fallback", snapshots: [buffering(99)] });
    const result = await drainBuffer(recorder, { getStatus: () => "ending_draining", sleep: noSleep });
    expect(result.drained).toBe(true);
    expect(recorder.kicks).toBe(0);
  });

  it("releases (drained:true) if the buffer degrades to fallback mid-wait", async () => {
    const recorder = fakeRecorder({
      snapshots: [buffering(2), { mode: "fallback", pendingCount: 0, pendingBytes: 0 }]
    });
    const result = await drainBuffer(recorder, { getStatus: () => "ending_draining", sleep: noSleep });
    expect(result.drained).toBe(true);
  });

  it("fails SAFE (drained:false) — never falsely 'saved' — if the poll cap is exhausted with chunks pending", async () => {
    const recorder = fakeRecorder({ snapshots: [buffering(5), buffering(5), buffering(5), buffering(5)] });
    const result = await drainBuffer(recorder, { getStatus: () => "ending_draining", sleep: noSleep, maxPolls: 2 });
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(5);
  });
});

describe("endPlanForDrain — stop()/retryEnd() gating (Defect A, the caller side)", () => {
  it("drained:true → submit end, clear the buffer, show the 'ended' completion", () => {
    expect(endPlanForDrain({ drained: true, pending: 0 })).toEqual({
      submitEnd: true,
      clearBuffer: true,
      showEnded: true,
      enterNotSaved: false,
      pending: 0
    });
  });

  it("drained:false → do NOT submit end, do NOT clear the buffer, do NOT show 'ended'; enter 'NOT saved'", () => {
    const plan = endPlanForDrain({ drained: false, pending: 160 });
    // The exact live-incident shape: 160 chunks unsent must NOT reach a green screen.
    expect(plan.submitEnd).toBe(false);
    expect(plan.clearBuffer).toBe(false); // the durable buffer is PRESERVED
    expect(plan.showEnded).toBe(false); // never the "safe to exit" completion
    expect(plan.enterNotSaved).toBe(true); // the loud, truthful state instead
    expect(plan.pending).toBe(160); // surfaced for the candidate + telemetry
  });
});

describe("canShowSafeExit — the single completion-screen predicate (Defect B)", () => {
  it("is true in fallback mode regardless of any reported count (no durable buffer)", () => {
    expect(canShowSafeExit({ bufferMode: "fallback", pendingCount: 0 })).toBe(true);
    expect(canShowSafeExit({ bufferMode: "fallback", pendingCount: 7 })).toBe(true);
  });

  it("is true when buffering and the pending count is exactly zero (provably empty)", () => {
    expect(canShowSafeExit({ bufferMode: "buffering", pendingCount: 0 })).toBe(true);
  });

  it("is FALSE when buffering with any pending chunk — the green checkmark is forbidden", () => {
    expect(canShowSafeExit({ bufferMode: "buffering", pendingCount: 1 })).toBe(false);
    expect(canShowSafeExit({ bufferMode: "buffering", pendingCount: 160 })).toBe(false);
  });

  it("is true when the recorder is absent (no live buffer to lose — e.g. fresh reload)", () => {
    expect(canShowSafeExit({ bufferMode: undefined, pendingCount: 0 })).toBe(true);
  });
});

// Composition guard: prove the two pieces together uphold the end-to-end
// invariant for the live-incident scenario — 160 chunks pending, candidate
// clicks resume mid-wait → status flips → NOT saved, buffer kept, no green screen.
describe("invariant — pending-and-unflushed can never become 'safe to exit'", () => {
  it("a mid-wait status flip with 160 pending yields a NOT-saved plan, not a completion", async () => {
    const recorder = fakeRecorder({ snapshots: [buffering(160), buffering(160)] });
    const sleep = vi.fn(noSleep);
    let calls = 0;
    const getStatus = () => (++calls <= 1 ? "ending_draining" : "recording");
    const drain = await drainBuffer(recorder, { getStatus, sleep });
    const plan = endPlanForDrain(drain);
    expect(plan.showEnded).toBe(false);
    expect(plan.clearBuffer).toBe(false);
    expect(plan.enterNotSaved).toBe(true);
    // And the completion predicate independently refuses the green screen.
    expect(canShowSafeExit({ bufferMode: "buffering", pendingCount: drain.pending })).toBe(false);
  });
});

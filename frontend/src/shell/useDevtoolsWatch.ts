// frontend/src/shell/useDevtoolsWatch.ts
//
// P1 (v1.1 anti-cheat) — the React hook that drives best-effort DevTools/Inspect
// detection during the exam. It polls the NON-freezing heuristics (size-delta +
// console-getter, devtoolsDetect.ts), edge-triggers a telemetry LOG on each open
// episode, and returns the live "open" flag so the caller can show a WARNING
// banner. It NEVER blocks (false-positive safety) and NEVER claims to be
// bypass-proof — see devtoolsDetect.ts header for the honesty contract.
//
// Wiring: StudentApp passes `enabled` (true only while recording) and `onOpen`
// (which emits a `devtools_opened` ProctorEvent through the normal event funnel,
// so it lands in the same telemetry/review channel as every other anomaly). The
// returned `devtoolsOpen` drives the candidate-facing warning.

import { useEffect, useRef, useState } from "react";
import { devtoolsTransition, sampleDevtoolsOpen, type DevtoolsWatchState } from "./devtoolsDetect";

const POLL_INTERVAL_MS = 1500;

export function useDevtoolsWatch({
  enabled,
  onOpen,
  onClose,
  intervalMs = POLL_INTERVAL_MS
}: {
  /** Only watch while true (e.g. status === "recording"). */
  enabled: boolean;
  /** Rising edge: a new DevTools-open episode. Emit telemetry here. */
  onOpen: () => void;
  /** Falling edge: DevTools closed again (optional). */
  onClose?: () => void;
  intervalMs?: number;
}): { devtoolsOpen: boolean } {
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const stateRef = useRef<DevtoolsWatchState>({ open: false });
  // Keep the latest callbacks without re-subscribing the interval each render.
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) {
      // Reset on disable so a later enable starts clean (a fresh episode logs).
      stateRef.current = { open: false };
      setDevtoolsOpen(false);
      return;
    }
    const tick = () => {
      let currentlyOpen = false;
      try {
        currentlyOpen = sampleDevtoolsOpen();
      } catch {
        // A locked-down console / odd embedding shouldn't crash the exam loop.
        currentlyOpen = false;
      }
      const { next, transition } = devtoolsTransition(stateRef.current, currentlyOpen);
      stateRef.current = next;
      if (transition === "opened") {
        setDevtoolsOpen(true);
        try {
          onOpenRef.current();
        } catch {
          /* telemetry emit must never throw into the poll loop */
        }
      } else if (transition === "closed") {
        setDevtoolsOpen(false);
        try {
          onCloseRef.current?.();
        } catch {
          /* ignore */
        }
      }
    };
    // Sample immediately (DevTools may already be open on entry) then on interval.
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);

  return { devtoolsOpen };
}

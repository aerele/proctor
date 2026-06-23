// frontend/src/candidate/panels/Rules.tsx
// Candidate leaf panels (extracted verbatim from App.tsx, F2). Props-driven.
import type React from "react";
import { AlertTriangle, Activity, Camera, CheckCircle2, ClipboardCheck, Copy, Eye, KeyRound, Mic, MonitorUp, ShieldCheck, Video } from "lucide-react";
import * as studentCopy from "../../studentCopy";

// Single source of truth for the test rules. The prominent PreStartRules block
// (pre-start) and the compact RulesPanel reminder (during recording) both read
// this so the rules never drift between the two surfaces. The TEXT lives in
// studentCopy.testRules (own-editor vs HackerRank variants, unit-tested); this
// zips it with one icon per rule, in the same fixed order. ownEditor is
// server-driven per session (S4: Boolean(sessionConfig?.problem)), so the
// rules are a function of it instead of a module constant.
const TEST_RULE_ICONS: React.ReactNode[] = [
  <MonitorUp size={18} />,   // Share your ENTIRE SCREEN
  <Video size={18} />,       // Keep your screen shared
  <Eye size={18} />,         // Stay on (HackerRank and) this tab
  <Copy size={18} />,        // Do your own work
  <Camera size={18} />,      // Keep your camera visible
  <ClipboardCheck size={18} /> // Press End test when you're done
];
const testRulesWithIcons = (ownEditor: boolean): Array<{ icon: React.ReactNode; title: string; body: string }> =>
  studentCopy.testRules(ownEditor).map((rule, index) => ({ icon: TEST_RULE_ICONS[index], ...rule }));

// PROMINENT pre-start rules — the candidate reads this before the form. This is
// the headline of the page at the form stage, not a sidebar afterthought.
// UX-H1: the caller passes ownEditorCopy (pinned ?contest= = own-editor), so a
// pinned candidate reads the own-editor rules pre-session instead of the
// legacy HackerRank variants.
export function PreStartRules({ hasProblem }: { hasProblem: boolean }) {
  const rules = testRulesWithIcons(hasProblem);
  return (
    <section className="mb-5 rounded-lg border border-warning/40 bg-warning/5 p-6 shadow-subtle">
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} className="mt-0.5 shrink-0 text-warning" />
        <div>
          <h2 className="text-xl font-semibold text-ink">Read the rules before you start</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            This session is proctored and recorded for a hiring assessment. Follow every rule below — violations are logged and reviewed before shortlisting.
          </p>
        </div>
      </div>
      <ol className="mt-5 grid gap-3 sm:grid-cols-2">
        {rules.map((rule, index) => (
          <li key={rule.title} className="flex gap-3 rounded-lg border border-line bg-panel p-4">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/5 text-accent">{rule.icon}</span>
            <div>
              <p className="text-sm font-semibold text-ink">
                <span className="mr-1.5 font-mono text-xs text-muted">{index + 1}.</span>
                {rule.title}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">{rule.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Compact rules reminder kept in the sidebar DURING recording so the candidate
// can re-check the rules at a glance without losing the live panels.
export function RulesPanel({ hasProblem }: { hasProblem: boolean }) {
  const rules = testRulesWithIcons(hasProblem);
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle size={18} />
        <h2 className="font-semibold">Rules reminder</h2>
      </div>
      <ul className="space-y-2.5 text-sm leading-6 text-muted">
        {rules.map((rule) => (
          <li key={rule.title} className="flex gap-2">
            <CheckCircle2 size={16} className="mt-1 shrink-0 text-accent" />
            <span><span className="font-medium text-ink">{rule.title}.</span> {rule.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// What the proctoring captures — shown in the form-stage sidebar so the candidate
// knows exactly what is recorded before they consent and start. Replaces the
// empty live panels (camera/health/evidence) that have nothing to show yet.
export function WhatIsRecordedPanel({ hasProblem }: { hasProblem: boolean }) {
  const items: Array<{ icon: React.ReactNode; label: string; detail: string }> = [
    { icon: <MonitorUp size={16} />, label: "Your entire screen", detail: "Recorded continuously and uploaded in short segments throughout the test." },
    { icon: <Camera size={16} />, label: "Camera (if available)", detail: "A small self-view; keep your face visible. Skipped if no camera is present." },
    { icon: <Mic size={16} />, label: "Microphone (if available)", detail: "Audio is captured alongside the screen when a microphone is present." },
    { icon: <Copy size={16} />, label: "Clipboard & paste activity", detail: "Copy/cut/paste inside the session is part of the integrity record." },
    // Own-editor only: Slice 1 records every keystroke (full text + timing) in
    // the coding workspace. The HackerRank fallback has no own editor, so this
    // line is omitted there.
    ...(hasProblem
      ? [{ icon: <KeyRound size={16} />, label: "Editor keystrokes", detail: "Everything you type in the coding editor, including keystroke timing, is recorded." }]
      : []),
    { icon: <Activity size={16} />, label: "Focus & network signals", detail: "Tab switches, hidden states, refreshes, exits, and IP changes are logged." }
  ];
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="font-semibold">What is recorded</h2>
      </div>
      <ul className="space-y-3 text-sm">
        {items.map((item) => (
          <li key={item.label} className="flex gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/5 text-ink">{item.icon}</span>
            <div>
              <p className="font-medium text-ink">{item.label}</p>
              <p className="mt-0.5 leading-6 text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

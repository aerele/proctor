// frontend/src/studentCopy.ts
//
// Candidate-facing copy that differs between the two test surfaces:
//   ownEditor=true  — a server problem is assigned (S4: sessionConfig.problem
//                     from the start/resume response); candidates solve in the
//                     built-in coding workspace, so no string may direct them
//                     to HackerRank or an external contest.
//   ownEditor=false — legacy flow; candidates open the external HackerRank
//                     contest via the Start test link, original copy verbatim.
//
// Deliberately NOT here: admin-facing text and the "Candidate ID" identity
// field label (S-A interim label; the WIRE field hackerrank_username keeps its
// name until S-E — it is the roster identifier, not a navigation instruction).

export type TestRuleCopy = { title: string; body: string };

// The six pre-test rule cards (PreStartRules) and the during-recording
// reminder (RulesPanel) both read this list, in this order. App.tsx zips it
// with the matching icon list.
export function testRules(ownEditor: boolean): TestRuleCopy[] {
  return [
    {
      title: "Share your ENTIRE SCREEN",
      body: "When prompted, choose Entire Screen — not a tab, window, or browser. Tab/window sharing is rejected and recording will not start."
    },
    {
      title: "Keep recording running",
      body: ownEditor
        ? "Screen recording is mandatory and continues even when this tab is hidden. Do not stop sharing until you have submitted your solution here."
        : "Screen recording is mandatory and continues even when this tab is hidden. Do not stop sharing until you have fully submitted on HackerRank."
    },
    {
      title: ownEditor ? "Stay on this tab" : "Stay on HackerRank and this tab",
      body: "Don't switch to other tabs, apps, or windows. Focus changes, hidden states, and exits are logged and may need explanation."
    },
    {
      title: "No copy / paste or outside help",
      body: ownEditor
        ? "Clipboard and paste activity is recorded. Everything you type in the coding editor, including keystroke timing, is recorded. Copied code, AI-assisted answers, search engines, or another person can lead to disqualification."
        : "Clipboard and paste activity is recorded. Copied code, AI-assisted answers, search engines, or another person can lead to disqualification."
    },
    {
      title: "Keep your camera visible",
      body: ownEditor
        ? "If a camera is available, keep the self-view (or its pop-out) visible while you work in the coding workspace. Microphone is captured when available."
        : "If a camera is available, keep the self-view (or its pop-out) visible while you work in HackerRank. Microphone is captured when available."
    },
    {
      title: "End the test here when done",
      body: ownEditor
        ? "After you submit your solution here, press End test. Closing the tab early is logged as an incomplete session."
        : "After you submit on HackerRank, return and press End test. Closing the tab early is logged as an incomplete session."
    }
  ];
}

// Consent-checkbox sentence (form stage). The own-editor variant discloses that
// editor keystrokes (full text + timing) are recorded, since Slice 1 captures
// every keystroke in the coding workspace; the HackerRank fallback has no own
// editor, so it must NOT claim keystroke capture. TRUTHFUL capture wording:
// the recorded webm is the screen stream + mixed microphone audio. F10.1 made
// the camera clause CONDITIONAL on the camera_recording setting (exam-config /
// upload_config): when enabled, a separate low-resolution camera video is
// recorded and the consent says so; when disabled, the camera is a live
// monitor (self-view) only and the consent must not claim a recording that
// does not exist (the post-F6 truthfulness bar, both directions).
export function consentDisclosure(ownEditor: boolean, cameraRecorded: boolean): string {
  const editorClause = ownEditor
    ? " Everything I type in the coding editor, including keystroke timing, is recorded."
    : "";
  const cameraClause = cameraRecorded
    ? "low-resolution camera recording where available"
    : "live camera monitoring";
  return `I have read the rules above and consent to screen recording, microphone recording where available, and ${cameraClause} for this hiring assessment.${editorClause} I understand that suspicious activity, stopped recording, copied code, or failed verification may lead to disqualification.`;
}

// Candidate-facing capture-state label for the CAMERA row/pill. F10.1: when
// the separate camera recording is enabled, a recording camera reads plainly
// as "recording"; when it is disabled the camera is a live monitor only
// (self-view / pop-out) and its internal "recording" state must not read as
// "recorded". Every other state (stopped / permission_denied / ...) passes
// through unchanged in both modes.
export function cameraStateLabel(state: string, cameraRecorded: boolean): string {
  if (state !== "recording") return state;
  return cameraRecorded ? "recording" : "monitored, not recorded";
}

// EndTestPanel confirmation copy (shown when the candidate presses End test).
export function endTestConfirmation(ownEditor: boolean): string {
  return ownEditor
    ? "End the proctoring session only after submitting your solution here. Closing the tab before this step is logged as an incomplete session. No code is needed — just confirm the assurance below."
    : "End the proctoring session only after submitting HackerRank. Closing the tab before this step is logged as an incomplete session. No code is needed — just confirm the assurance below.";
}

// Entry-review "Tabs" audit line shown to the candidate after recording starts.
export function tabAuditMessage(ownEditor: boolean): string {
  return ownEditor
    ? "Tab/focus review active. Keep only this proctor session open; other activity may be visible in the shared-screen recording."
    : "Tab/focus review active. Keep only HackerRank and this proctor session open; other activity may be visible in the shared-screen recording.";
}

// Form-stage page intro under the headline (before the candidate starts).
export function formStageIntro(ownEditor: boolean): string {
  return ownEditor
    ? "Enter your details below, then start proctoring to unlock the coding workspace. When you start, your browser will ask which screen to share — choose Entire Screen."
    : "Enter your details below, then start proctoring before you open the contest. When you start, your browser will ask which screen to share — choose Entire Screen.";
}

// Rotating integrity notices logged into the candidate's event feed while
// recording. Only the submissions-similarity notice is surface-specific.
export function integrityNotices(ownEditor: boolean): string[] {
  return [
    "Your screen recording is being uploaded throughout the assessment for review.",
    "The shared screen is recorded directly so capture continues while this proctor tab is hidden.",
    "If a camera is available, keep your face visible in the self-view throughout the assessment.",
    "Clipboard snapshot and paste activity inside this session are part of the integrity record.",
    "Focus changes, hidden page states, refreshes, and exits are logged and may require explanation.",
    "Stopping screen sharing before submission is treated as a serious proctoring violation.",
    ownEditor
      ? "Submitted code may be checked for similarity, unusual structure, and copied code patterns."
      : "HackerRank submissions may be checked for similarity, unusual structure, and copied code patterns.",
    "Shortlisted candidates must be ready to explain and modify their submitted code live.",
    "Suspicious candidate-ID/session behavior may lead to manual verification before shortlisting.",
    "Upload gaps, missing recording chunks, and interrupted sessions are reviewed before results are accepted.",
    "Any unexplained proctoring anomaly can affect shortlisting even if the code passes all tests.",
    "Selection depends on score, originality, explanation, and clean proctoring evidence."
  ];
}

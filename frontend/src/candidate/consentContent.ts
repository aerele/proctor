// frontend/src/candidate/consentContent.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SINGLE SWAPPABLE SOURCE OF TRUTH for the candidate Terms & Conditions    │
// │  and Privacy Policy copy. Karthi: to bless / update the wording, edit     │
// │  ONLY this file. Nothing else needs to change.                            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// G1 (v1.1 privacy & consent): the consent gate blocks entry until the
// candidate has VIEWED the Terms page AND the Privacy page, made the consent
// choice, and confirmed right-to-consent. Those two pages are rendered (as
// markdown, via react-markdown — the same renderer the problem statements use)
// from the `terms` / `privacy` strings below.
//
// The copy is KEYED BY consent_version. The structured consent sent on session
// start records which version the candidate agreed to (the design contract,
// per internal design notes). When the wording changes MATERIALLY, add a new
// version entry below and bump CONSENT_VERSION — the new text then applies to
// every NEW session, while already-consented sessions keep the version they
// saw (resume never re-prompts).
//
// Two dynamic substitutions are interpolated at render time so the pages stay
// truthful PER-CONTEST without editing this file:
//   {N}            → the contest's evidence_retention_days (the "erased after N
//                    days" window — default 4, admin-editable per contest).
//   {PROCTOR_TAIL} → for a remote take-home contest, "call your proctor on the
//                    number shown on your screen"; in-venue, "ask your
//                    invigilator". Empty-safe.
//
// Content draft source: internal design notes (privacy/T&C drafts).
// PENDING final okay — placeholders in [SQUARE BRACKETS] are factual
// items he must fill (organisation legal name, jurisdiction, grievance contact,
// dates). They render verbatim so a missed placeholder is impossible to miss.

// The authoritative consent text version. Bump on a MATERIAL copy change.
// Mirrored by the backend CONSENT_VERSION (design §1.3); the frontend falls
// back to this when the served exam-config omits consent_version (legacy doc).
export const CONSENT_VERSION = "v1.1";

export type ConsentDoc = {
  /** Short page title rendered as the modal header. */
  title: string;
  /** Markdown body (react-markdown + remark-gfm). */
  markdown: string;
};

export type ConsentVersionContent = {
  version: string;
  /** Human "last updated" line shown under each page title. */
  lastUpdated: string;
  terms: ConsentDoc;
  privacy: ConsentDoc;
};

// ---- v1.1 content ------------------------------------------------------------
// Edit the strings below to change the live copy. Keep {N} and {PROCTOR_TAIL}
// where the per-contest values should appear.

const V1_1: ConsentVersionContent = {
  version: "v1.1",
  lastUpdated: "[DATE — Karthi to fill]",
  terms: {
    title: "Terms & Conditions",
    markdown: `Please read these Terms before you start your test. By checking the consent box and starting the proctored session, you agree to them. **If you do not agree, do not start the test** — you can contact the organisation running the contest (or {PROCTOR_TAIL}) about alternatives.

## 1. What this is

This is a **proctored coding contest** run on the Aerele Proctor platform on behalf of **[ORGANISATION LEGAL NAME — Karthi to fill]** ("the Organisation", "we", "us"). The Organisation uses this test to assess your coding ability for **hiring / shortlisting**, and the proctoring exists to keep the test fair for everyone.

The test may be taken in one of two ways:

- **At your college / on-site**, supervised by an invigilator, or
- **Remotely / take-home**, with on-screen support available by phone.

## 2. The test is monitored and recorded

This is not an ordinary web page. While the session is running, the platform records and logs your activity so that the Organisation can verify the result. By starting, you understand and accept that the following are captured:

- **Your entire screen**, recorded continuously and uploaded in short segments throughout the test.
- **Your camera (webcam)**, where one is available — by default a small, low-resolution video is recorded; otherwise it is shown as a live self-view monitor only.
- **Your microphone audio**, where a microphone is available.
- **What you type in the coding editor**, including keystroke timing (when you solve in our built-in workspace).
- **Clipboard and paste activity** inside the session.
- **Focus, visibility and network signals** — tab switches, the page being hidden, refreshes, exits, and changes in your network/IP address.
- **Your code submissions and sample-run events.**

A recording indicator is shown while capture is active. You can see exactly what is being captured on the **"What is recorded"** panel before you start.

> **Honest about limits.** This is browser-based proctoring — evidence collection for human review, not lockdown software. We do not install anything on your computer, and we cannot see other applications, other devices, or anything outside the browser tab and the screen you choose to share.

## 3. Permissions and setup you must allow

To take the test you must grant the browser permissions the test asks for:

- **Screen sharing** — when prompted, choose **Entire Screen** (not a single tab or window; tab/window sharing is rejected and recording will not start).
- **Camera** and **microphone**, where available.
- **Fullscreen mode** — the test runs in fullscreen and leaving it is logged and may lock the session.

You are responsible for a working device, browser, camera/microphone (where required), and a stable internet connection.

## 4. Rules of the test

You agree to:

- **Keep recording running** until you have submitted and ended the test. Stopping screen sharing before you submit is treated as a serious violation.
- **Stay on the test tab** — do not switch to other tabs, apps, or windows.
- **Do your own work** — no copied code, AI-assisted answers, search engines, or help from another person.
- **Keep your face visible** in the camera self-view, where a camera is available.
- **End the test here** when you are done, using the End test button.

## 5. Integrity, review and consequences

Captured evidence and signals are reviewed by people, not used for automatic rejection. Suspicious activity, stopped recording, copied code, unusual submission patterns, failed identity verification, or unexplained proctoring anomalies **may be reviewed and can affect your result or lead to disqualification**, even if your code passes the tests. If you are shortlisted, you may be asked to explain and modify your submitted code live.

## 6. Honest behaviour and your identity

You confirm that you are the person identified by the roll number / identifier you enter, that you are taking the test yourself, and that the information you provide is accurate.

## 7. Your data

How your data is collected, used, kept, and deleted is described in the **Privacy Policy**, which forms part of these Terms. In short: proctoring data (recordings, audio, camera, keystroke and activity logs) is **deleted after a short retention window of {N} days** once this contest concludes. Only your **roll number / identifier, your scores, and the evaluation result** are kept after that.

## 8. Availability and fairness

We try to keep the platform working smoothly, but no software is perfect. If you hit a technical problem during the test:

- **On-site:** raise it with your invigilator.
- **Remote / take-home:** call the proctor on the **support number shown on your screen**.

Genuine technical issues (for example a brief network change) are taken into account during review and will not by themselves be held against you.

## 9. Changes and contact

The Organisation may update these Terms; the version shown when you take the test is the one that applies to your session. For questions about the test, contact **[ORGANISATION CONTACT — Karthi to fill]** (remote candidates: use the on-screen proctor support number).

These Terms are governed by the laws of **[JURISDICTION / COUNTRY — Karthi to fill]**.`
  },
  privacy: {
    title: "Privacy Policy",
    markdown: `This Privacy Policy explains what personal data we collect when you take a proctored coding contest on the Aerele Proctor platform, why we collect it, how long we keep it, and your choices. It is written to be read by candidates — plainly, not in heavy legalese.

The contest is run by **[ORGANISATION LEGAL NAME — Karthi to fill]** ("the Organisation", "we", "us"), who decides how your data is used. The platform is self-hosted by the Organisation.

## 1. What we collect

**Identity and result data**

- Your **roll number / identifier** (and, where the roster provides it, your name and college).
- Your **code submissions**, **scores**, and the **evaluation result**.

**Proctoring data (captured while the test is running)**

- **Screen recording** — your entire shared screen, recorded continuously and uploaded in short segments throughout the test.
- **Camera (webcam) video** — by default a small, low-resolution recording where a camera is available; otherwise a live self-view only, not recorded.
- **Microphone audio**, where a microphone is available.
- **Editor / keystroke events** — what you type in the coding workspace, including keystroke timing (in our built-in editor).
- **Clipboard and paste activity** inside the session.
- **Focus, visibility and network events** — tab switches, hidden-page states, refreshes, exits, and changes to your network / IP address.
- **Run and submission events** — when you run samples or submit code.

We do **not** install software on your device, and we cannot see other applications, other devices, your OS clipboard outside the session, or anything beyond the browser tab and the screen you choose to share.

## 2. Why we collect it

We use this data for two purposes only:

1. **Integrity monitoring** — to keep the test fair and to detect and review possible malpractice.
2. **Talent / hiring evaluation** — to assess and shortlist candidates for the Organisation.

We do not sell your data or use it for advertising.

## 3. Consent

We collect proctoring data **only with your consent**, which you give by checking the consent box before the test starts. **Consent is required to take the test** — if you decline, you cannot proceed. You can withdraw by stopping the test, but note that an incomplete or stopped session may mean your attempt cannot be evaluated.

## 4. How long we keep it — and what gets deleted

**Proctoring data is short-lived.** Recordings, camera video, microphone audio, screen segments, keystroke and activity events, and your other personal proctoring data are **automatically erased {N} days** after this contest concludes. The exact window — and when that {N}-day clock starts — is configured per contest. Only your roll number / identifier, your scores, and the evaluation result are kept after that.

**After the retention window, only this is kept:**

- your **roll number / identifier**,
- your **scores**, and
- the **evaluation result**.

This minimal record lets the Organisation keep a defensible result and recognise you across rounds, without retaining your recordings or other sensitive proctoring data.

## 5. Who can see your data

- The **Organisation's admins and reviewers** running the contest.
- **Invigilators**, for the room they supervise (on-site mode).
- The platform's infrastructure provider (cloud storage / compute) strictly to host the service.

Candidates **cannot** see each other's recordings, scores, or results. Your data is not shared with anyone else except where required by law.

## 6. Where your data is stored

Proctoring evidence is stored in the Organisation's own cloud storage and database, with access restricted to the Organisation. **[Storage region / country — Karthi to fill if disclosure is desired.]**

## 7. Your rights

Depending on where you live, you may have rights over your personal data — for example to ask what we hold, to ask for a copy, or to ask us to correct or delete it. Because proctoring data is automatically deleted after a few days, most of it will already be gone shortly after your test. To make a request, contact us using the details in section 9.

## 8. Security

We take reasonable measures to protect your data: access is restricted, recordings are stored in access-controlled cloud storage, and proctoring data is deleted on the retention schedule above. No system is perfectly secure, but we work to keep your data safe for as long as we hold it.

## 9. Contact

For any privacy question or request, contact:

- **Data / grievance contact:** **[NAME + EMAIL/PHONE — Karthi to fill]**
- **Remote take-home candidates:** for help during the test, call the **proctor support number shown on your screen**.

This Policy is governed by the laws of **[JURISDICTION / COUNTRY — Karthi to fill]**.`
  }
};

// The version registry. Add a new entry (and bump CONSENT_VERSION) on a material
// copy change; old sessions resolve their own stored version here for audit.
const CONTENT_BY_VERSION: Record<string, ConsentVersionContent> = {
  [V1_1.version]: V1_1
};

/**
 * Resolve the content for a consent version, falling back to the current
 * CONSENT_VERSION content when the requested version is unknown (e.g. a legacy
 * contest serving no consent_version, or a version that predates this build).
 */
export function consentContentFor(version: string | null | undefined): ConsentVersionContent {
  const key = (version || "").trim();
  return CONTENT_BY_VERSION[key] || CONTENT_BY_VERSION[CONSENT_VERSION] || V1_1;
}

/**
 * Interpolate the per-contest dynamic values into a markdown body. PURE so it is
 * unit-tested. `{N}` becomes the retention-day phrase (with correct day/days
 * pluralisation); `{PROCTOR_TAIL}` becomes the remote/in-venue help tail.
 */
export function renderConsentMarkdown(
  markdown: string,
  opts: { retentionDays: number; takeHome?: boolean; proctorPhone?: string }
): string {
  const days = Number.isFinite(opts.retentionDays) && opts.retentionDays > 0 ? Math.floor(opts.retentionDays) : 4;
  const unit = days === 1 ? "day" : "days";
  const proctorTail = opts.takeHome
    ? `call your proctor${opts.proctorPhone ? ` on ${opts.proctorPhone}` : " on the number shown on your screen"}`
    : "ask your invigilator";
  return markdown
    .replace(/\{N\} days/g, `${days} ${unit}`)
    .replace(/\{N\}/g, String(days))
    .replace(/\{PROCTOR_TAIL\}/g, proctorTail);
}

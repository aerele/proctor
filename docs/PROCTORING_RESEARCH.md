# Proctoring a HackerRank Contest We Cannot Iframe — Authoritative Decision Report

**Date:** 2026-06-05 · **Audience:** Karthi (pre-build decision) · **Constraint:** HackerRank contest runs in a tab/window we do not own (XFO: SAMEORIGIN behind Akamai). Our app is a browser-based companion.

This report reconciles 5 research lanes against an adversarial reality-check. Where they conflicted, the reality-check won. Two "shifting ground" claims were independently re-verified today against primary sources (Apple Developer Forums, HUMAN Security) and are folded in.

---

## 1. Executive Summary

- **You are building a tier-1, observe-only evidence collector, not a lockdown.** A browser companion that cannot iframe the contest cannot see the contest tab's DOM/keystrokes/clipboard, cannot enumerate OS processes, cannot see a transparent AI overlay, cannot see a second device, and enforces nothing. This is a hard architectural ceiling, confirmed across all 5 lanes and the critique. Design and market accordingly — anything stronger requires a native agent (HackerRank's own Desktop App is exactly that).

- **The spine of the product must be a live oral defense / "explain and extend your code" round — not surveillance.** It is the *only* measure that simultaneously neutralizes invisible overlays (Cluely), agentic browsers (Comet/Atlas), second devices, virtual cameras, and VMs — none of which a browser can see — because it tests *understanding*, not screen state. Every lane lands here; promote it from a footnote to the headline. All browser signals become *triage that decides who gets the oral round*.

- **The best thing the browser itself does is full-screen `getDisplayMedia` capture with verify-and-refuse**, plus the `track 'ended'` event as a stop-tripwire. You cannot *compel* a whole-screen share, but after the user picks you can read `getSettings().displaySurface` and reject anything that isn't `'monitor'`. This is evidence, not enforcement, and it does **not** reveal a Windows overlay.

- **An MV3 extension is a real capability step up, but its one enforcement primitive (`declarativeNetRequest` allowlist) is only a *cage* on an enterprise-managed/force-installed fleet.** On a student's own BYOD laptop the extension is removable in two clicks and only governs one Chrome profile — so it's a speed-bump + tamper signal, not a lock. The extension's genuine value is *visibility* (authoritative tab-switch/new-tab events and a content script injected into the real hackerrank.com tab), not enforcement.

- **Drop the theater outright:** eye/gaze-direction cheating flags (webcam gaze accuracy ceiling makes "overlay reading" undetectable, plus bias/false-accusation liability), Page-Visibility/blur on *our* tab as a cheating signal, clipboard/keystroke blocking on our own page, DevTools-detection, and any "we block Cluely / AI browsers" claim. Marketing detection you can't deliver is the trap Honorlock/Talview fall into.

- **Require Chromium desktop (Chrome/Edge ≥ a recent floor); block Firefox, Safari, and all mobile.** The defensible reason is narrow and concrete: `getDisplayMedia` `displaySurface` introspection and `screen.isExtended` multi-monitor detection are Chromium-only, and Safari's `displaySurface` is broken since it moved to the system picker. Don't justify the gate on the kiosk-API trio (Keyboard Lock / Window Management / Idle Detection) — you're not relying on those for enforcement.

- **The ground is moving — don't over-claim impossibility either.** On **macOS 15.4+** Apple's ScreenCaptureKit now composites all windows into one framebuffer and *ignores* content-protection, so a forced full-screen capture on a patched Mac can *incidentally* catch an overlay (re-verified today, Apple Developer Forums). And agentic browsers *do* leave server-side signatures (CFNetwork/Darwin UA) beyond a spoofable client UA. Tell stakeholders "we provably can't catch X *from a browser*" — but note the arms race has tilted on macOS and that real detection of these exists server-side, just not in our client.

- **Net posture:** identity + liveness up front → full-screen evidence recording (verify-and-refuse) → multi-monitor flag + webcam phone-detection + behavioral timing → server-side risk score → **mandatory live oral defense for flagged candidates.** Explicitly NOT a lockdown, explicitly NOT an overlay/AI-browser detector.

---

## 2. How Real Proctoring Tools Work

| Tool | Mechanism / Tier | What it actually catches | Known bypass / limit |
|---|---|---|---|
| **HackerRank "Secure Mode"** | Web JS (Fullscreen + Page Visibility + clipboard events) | Tab-switch *alerts*, copy/paste disable, fullscreen-exit — **observe/alert only** | Page Visibility overridable by userscript; blur ≠ hidden; enforces nothing |
| **HackerRank "Proctor Mode"** | Web JS + `getDisplayMedia` + AI | Webcam snapshot/5s (phone/multi-face), screenshot/15s, multi-monitor check, copy-paste, "type-then-delete" pattern | Candidate must click-Allow share & can decline; can't see 2nd device beyond webcam frame; can't see overlay |
| **HackerRank Desktop App** | **Native agent** | *Actually* closes unauthorized apps (names Cluely/Ultracode), blanks screenshots, OS-fullscreen, VM detect, disconnects extra monitors | Runs on user's HW → bypassable given time (USENIX ceiling); requires install |
| **Proctorio** | **MV3 browser extension** | Locks tab, blocks tab-switch/clipboard, webcam/screen record, AI flags; Nov-2025 auto-removes on MITM proxy + blocks Comet/Atlas | Extension can't see other processes → **can't catch native overlay**; AI-browser block is fingerprint/UA → spoofable client-side |
| **Honorlock** | Extension + live pop-in proctors (+ optional desktop app) | "Patented" honeypot search-bank detection, Apple-Handoff phone detection, "Hey Siri" audio keywords | **Admits** it "cannot capture web traffic from other devices"; overlay-block needs the *desktop* app |
| **Respondus LockDown Browser** | **Custom forked Chromium / kiosk** | Locks desktop, blocks print/copy/2nd-monitor/app-switch, logs keystrokes, webcam (w/ Monitor) | Windows Sandbox / VM (until patched ~2025), Alt-Tab tricks, DLL-injection (UndownUnlock); **blind to phone/2nd laptop** |
| **Safe Exam Browser (SEB)** | Custom kiosk + server handshake (Browser Exam Key) | Locks OS, VM-refusal, HTTP header attestation to LMS | **Header-only attestation spoofable** when server pattern-matches instead of verifying hash (exam.net bypass); admin toggle allows VM; concedes "no security vs secondary devices" |
| **Mercer Mettl MSB / Talview** | **Native secure browser + AI** | Blocks email/browsers/VM/RDP/screen-share, disables USB; vendor-claimed "95%" AI accuracy | Native = bypassable given time; "95%/Cluely-detection" is vendor self-report; overlay-block needs OS access |
| **ProctorU / Guardian** | Live human + LogMeIn screen-share agent | Live human catches blatant in-room help | Independently audited "trivially bypassable"; 444k-user breach; can't see phone below desk |
| **Codility** (coding analogue) | **Pure-web behavioral logging** | Copy-paste tracking, tab-switch events, time-on-task — *evidence timeline*, not lockdown | This is the realistic ceiling for a browser-only coding proctor — and it instruments *its own* page, which we can't |

**Foundational truth (USENIX Security 2022, "Watching the watchers"):** all anti-cheat runs on hardware the candidate fully controls with admin rights, so *every* measure is bypassable given time — only the cost/skill bar moves. VM detection is a CPU-vendor string check; webcam-ID checks are beaten by virtual cameras; "secure mode" header handshakes are spoofable unless cryptographically verified server-side. A browser companion is the *weakest* tier and provides ~zero hard enforcement — only evidence.

---

## 3. Browser-Page vs Extension Capability Table

This is the core input to the **A (extension) vs C (web-only)** decision. "Reliability" = how much you can trust the signal *for this use case* (a no-iframe companion).

| Primitive | Web-page reliability | Extension reliability | Extension-only? | Verdict |
|---|---|---|---|---|
| **`getDisplayMedia` full-screen capture + `getSettings().displaySurface` verify-and-refuse** | **Good (best web signal)** — can't compel choice, can verify after | Same + can also `tabCapture` | No | **Keep — evidence spine.** Chromium-only introspection |
| **`track 'ended'` (share stopped)** | Reliable tripwire | Reliable | No | **Keep** |
| **`screen.isExtended` (2nd monitor)** | Reliable, no prompt, **Chromium-only** | Reliable | No | **Keep — flag, don't block.** Detects display not 2nd computer |
| **`getScreenDetails()` per-screen detail** | Behind window-management *prompt* (deniable) | Same | No | Keep; treat denial as a flag |
| **Page Visibility (`visibilitychange`)** | **Weak** — only *our* tab, overridable by userscript, blur≠hidden | Authoritative **across all tabs** via `chrome.tabs`/`windows.onFocusChanged` | The *cross-tab* version is | **Web: log only (NOT a violation).** Extension upgrades it to real |
| **`window` blur/focus** | Noisy, *our* tab only | `windows.onFocusChanged` = focus left Chrome entirely | Cross-browser version is | Web: soft corroboration only |
| **Fullscreen API + `fullscreenchange`** | Tripwire only — always exitable (Esc/F11) | Same | No | **Tripwire/evidence, never a lock** |
| **Keyboard Lock (`navigator.keyboard.lock`)** | Chromium-only, in JS-fullscreen only, can't beat Ctrl+Alt+Del, 2s-hold-Esc escape | Same | No | Friction + evidence only; useless FF/Safari |
| **Clipboard block (preventDefault copy/paste)** | **Theater** — *our* page only, trivially bypassed | Content script can watch paste **in the hackerrank tab** | The in-exam version is | Web: drop. Extension: real signal |
| **Idle Detection (`IdleDetector`)** | Chromium-only, ≥60s granularity, permission-gated, Brave default-off | Same | No | Supplementary signal only |
| **DevTools-open detection** | **`no-or-defeatable`** — false +/-, spoofable, can't see exam tab | n/a | — | **Drop** |
| **`beforeunload`** | Can't block leave; unreliable | n/a | — | **Drop as integrity** |
| **Tab-switch / new-tab / navigation events (`chrome.tabs`/`windows`/`webNavigation`)** | **Impossible** — page sees only itself | **Authoritative across whole browser**, reads target URLs | **YES** | **The categorical extension win (visibility)** |
| **Content script injected INTO hackerrank.com tab** | **Impossible** cross-origin | Observes paste/copy/visibility/typing-cadence **on the real exam page** | **YES** | **Biggest thing a web page can't do** (isolated-world; needs hands-on test vs their editor) |
| **`declarativeNetRequest` site allowlist** | **Impossible** | Blocks all sites except hackerrank+proctor **in that one profile** | **YES** | **Only true in-browser enforcement — but cage ONLY on force-installed managed fleet.** BYOD = speed-bump + tamper signal |
| **`chrome.debugger` (CDP)** | n/a | Powerful but shows persistent "started debugging" banner; conflicts with real IDE/DevTools | YES | **Do NOT ship** (not "optional") |
| **Extension presence heartbeat (gate the exam)** | Page detects content-script handshake; refuse start if missing | — | Pattern | Good gate — but only *detects* removal, can't prevent it; harden with server nonce |
| **VM/RDP fingerprint (WebGL renderer, hardwareConcurrency, WebRTC IP)** | **`no-or-defeatable`** — spoofable, false-+ on legit low-end | Same | No | **Soft risk score only, never hard-block** |
| **Virtual-camera detection (`MediaDeviceInfo.label`)** | Label string-match only, defeated by rename | Same | No | Lazy-cheater tripwire only |

**Decision takeaway:** the extension buys you exactly three things a web page *cannot* have — (1) authoritative cross-tab/new-tab/navigation visibility, (2) a content script *inside the real exam page*, (3) a network allowlist (enforcement only when force-installed). Everything else (screen capture, webcam, multi-monitor, idle, fullscreen) the web page already does. So the A-vs-C choice hinges entirely on whether you can *force-install* the extension on managed machines and whether you need in-exam-tab instrumentation. See §7.

---

## 4. The Overlay / Hidden-Window Honest Threat Model

**Blunt version: the most dangerous 2025-26 vector — a transparent always-on-top AI overlay (Cluely, Interview Coder, Leetcode Wizard) fed answers in real time — is undetectable from a browser, and forcing whole-screen capture does NOT reliably reveal it.**

**What is NOT detectable from a browser (do not claim it):**
- **The overlay window itself.** No web API enumerates other processes/windows/z-order. The exam browser and the overlay are separate processes. Interview Coder markets that "the browser running the interview… simply cannot see or interact with it." Our companion is *worse off* than the contest tab — it can't even see the contest tab.
- **On Windows, the overlay is airtight-invisible even under full-monitor capture.** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` makes DWM strip the window from *every* capture path — BitBlt, DXGI Desktop Duplication, *and* Windows Graphics Capture (what `getDisplayMedia` "monitor" uses). Microsoft Learn confirms the window "does not appear at all" elsewhere. So the textbook mitigation "require `displaySurface==='monitor'`" does **not** defeat a Windows overlay — it's gone from that stream too.
- **Second device / phone / smart-glasses / printed notes / confederate out of frame.** The universal unsolved gap across *every* tool from Respondus to HackerRank Desktop. Only countermeasure from a browser is webcam phone-in-frame object detection, trivially evaded by keeping the device out of frame.
- **VM / RDP / AnyDesk / TeamViewer.** Browser heuristics are spoofable and false-positive-prone; only a native lockdown agent reliably catches these.

**The one place the ground has shifted (re-verified today):**
- **macOS 15.4+ (Sequoia): ScreenCaptureKit now composites all windows into one framebuffer and *ignores* `NSWindow.sharingType=.none`/`setContentProtection`** (Apple Developer Forums thread 792152; Tauri #14200 — "no known workaround"). Since browser `getDisplayMedia` "monitor" capture on macOS goes through ScreenCaptureKit, a forced full-screen capture on a *patched Mac* can **incidentally include the overlay**. Real-world 2026 recruiter reports corroborate Cluely users getting caught as Zoom/CoderPad moved to ScreenCaptureKit. **But you cannot rely on it:** the candidate owns the OS and can stay on macOS 14, switch to Windows (airtight), or change tools. So this is a *sometimes-it-leaks* signal, not a control.

**Why webcam gaze does NOT save you (correcting Lane 3's optimism):** calibration-free webcam eye-tracking runs ~5° average offset (≈ several lines of an IDE at normal viewing distance), degrades sharply with head movement, and cannot distinguish "reading an overlay near the code" from "reading the code." Distinguishing reading-saccades from normal IDE scanning is below the noise floor. The only gaze signal with *any* merit is the coarse "eyes repeatedly drop to a fixed off-screen point" (possible second device) — and even that is a soft, bias-laden prior. **Do not ship gaze-direction cheating flags** (consistent with Lane 1's correct "gaze tracking is theater," AutoProctor removing it, and the USENIX skin-tone-bias finding).

**Realistic mitigations instead:**
1. **Live oral defense / code-walkthrough** — neutralizes the overlay by testing understanding. The only robust answer.
2. **Behavioral *timing* you can actually see** — flat per-question latency (the Cluely 3–5s tell) from *your own* UI events → feed human review, never auto-fail.
3. **Webcam phone-in-frame object detection** — real but frame-evadable; a flag.
4. **`screen.isExtended` multi-monitor flag** — free, genuine.
5. **If you ever need true overlay/process detection: an optional native helper is the *only* path.** Be explicit it's a different product.

**Marketing rule:** any browser-only "we detect Cluely / block AI browsers" claim is the theater trap. AI-browser blocking that *works* (Proctorio's Comet/Atlas block, the CFNetwork/Darwin UA signatures HUMAN Security documents) is **server-side**, and you'd have to build it; the client-side UA check is trivially spoofed.

---

## 5. Browser Support & Gating Policy

**REQUIRE: Desktop Chrome / Edge (Chromium), recent floor.** Pick a floor of **≥ Chrome/Edge 130** (gives `monitorTypeSurfaces` from 119, the settled Keyboard-Lock permission model from 130, and reliable `displaySurface` introspection). Confirm against your actual student population's installed versions.

**BLOCK: Firefox, Safari, all mobile/tablet.**
- **Firefox/Safari** support *none* of `screen.isExtended` / Window Management / Keyboard Lock / Idle Detection / `userAgentData`. **The decisive, defensible reasons** (narrower than the kiosk-API trio): Safari's `getDisplayMedia` `displaySurface` is **broken/ignored** since it moved to the macOS system picker (mdn/content #42218), so you can't verify what they shared; and `screen.isExtended` multi-monitor detection is Chromium-only. Don't justify the block on Keyboard Lock / Idle / Window-Management — you're not relying on those for enforcement.
- **All mobile**: no `getDisplayMedia` on any mobile browser (iOS Safari never), iOS fullscreen is `<video>`-only. Block outright.

**Brave: special-case.** It *is* Chromium and passes feature-detects, but Idle Detection is default-off, screen-capture has reported bugs (brave-browser #47243), and farbling perturbs signals. Detect via `navigator.brave?.isBrave()` and either block or run a strict permission pre-flight that confirms each capture/permission *actually* granted.

**Detect reliably — feature-detect, NOT the UA string:**
```
// Strongest non-bypassable usability gate: a spoofed UA can't fake a missing API
const ok =
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
  'isExtended' in window.screen &&                       // Chromium multi-monitor
  // verify displaySurface is actually readable at capture time
  !!navigator.userAgentData;                             // absent => non-Chromium => block
// version floor + Brave unmask:
const v = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
```
Use `userAgentData.getHighEntropyValues(['fullVersionList'])` *only* for the version-floor check and Brave un-masking — never as the primary gate (client hints are spoofable via ModHeader/DevTools). The primary gate is **live feature-detection of the real APIs**, because a spoofed UA that lacks the real API fails naturally.

**Re-validate at exam *start*, not just page load:** a feature can *exist* but be permission-denied or default-off. Confirm `getDisplayMedia()` returned an active `'monitor'` track and each `requestPermission()` returned `granted`; block start and show *which specific check failed* (camera, share-was-tab-not-monitor, second-monitor-detected, permission-denied) so honest students self-correct.

**This validates the industry posture:** Proctorio already requires latest Chrome/Edge desktop and blocks everything else. Gating is a *usability* gate (refuse to start), never a security control.

---

## 6. Iframe Reality

**Confirmed dead, not theater — and not a bug to route around.** Whether a page can be framed is decided entirely by the *embeddee* via `X-Frame-Options` and/or CSP `frame-ancestors`; the browser enforces the framed site's policy and there is **no client-side bypass**. HackerRank sends XFO: SAMEORIGIN behind Akamai, so it cannot be embedded, period. Even a *cooperative* cross-origin frame leaks nothing useful (no DOM, keystrokes, scroll, focus, URL — only what the child voluntarily `postMessage`s). The only technical workaround — a content-rewriting reverse proxy that strips XFO/CSP — is operationally unviable and legally risky here: Akamai scores the connection via JA3/JA4 TLS fingerprinting *before any HTML returns*, it MITMs the student's authenticated session, and it circumvents a deliberate protection (HackerRank ToS / CFAA / anti-circumvention grey zone). HackerRank's own proctoring confirms the architecture: meaningful lockdown requires their JS running *in* the exam origin or their *native* Desktop App — never framing from outside.

**Alternatives:** open the contest in a separate tab/window the student launches; treat it as a black box; gather evidence out-of-band (full-screen `getDisplayMedia`, webcam/mic via `getUserMedia` on our own origin, our-tab visibility as soft corroboration); go extension or native for any cross-tab visibility or OS-level lockdown.

---

## 7. Recommended Approach for OUR App

### A (MV3 Extension) vs C (Web-only evidence) — the recommendation

**Recommendation: build C (web-only evidence) as the shipping product now, and architect the extension (A) as an *optional, force-installable* upgrade for managed/proctored cohorts — do NOT make the extension a load-bearing enforcement layer on BYOD student laptops.**

**Concrete capability delta that justifies this:**
- The extension's *enforcement* primitive (`declarativeNetRequest` allowlist) is a **real cage only when force-installed via enterprise policy on a managed machine.** On a student's own laptop it's removable in two clicks and governs one profile — a speed-bump + tamper signal, not a lock. If your contest population is BYOD, the extension buys you *visibility*, not enforcement.
- The extension's *visibility* wins (authoritative tab-switch/new-tab events + a content script inside the hackerrank.com tab to watch paste/typing-cadence) are genuinely valuable **and impossible from a web page** — but they're triage signals feeding human review, the same role the web-only signals play. They raise signal quality, not the enforcement ceiling.
- Web-only (C) already delivers everything that *matters* for an evidence-and-triage product: full-screen recording with verify-and-refuse, webcam/mic, multi-monitor flag, idle, our-tab focus signals.
- **Therefore:** if you can force-install on managed machines → ship A for those cohorts (real allowlist enforcement + in-exam-tab instrumentation). For everyone else, C is the honest ceiling and the extension adds triage polish, not a cage. Don't let the roadmap pretend an installable-by-choice extension is "lockdown."

*(One thing to verify hands-on before committing to A's in-tab instrumentation: whether a content script's isolated-world DOM/event observation is sufficient to catch paste/copy in HackerRank's Monaco/CodeMirror editor, or whether main-world injection is needed and whether their CSP/Akamai interferes — Lane 2 open question.)*

### Prioritized "best practices that actually work" checklist, mapped to roadmap epics

**EPIC: Live submission eval (HIGHEST VALUE — make this the spine)**
- [ ] **Mandatory live oral defense / code-walkthrough for flagged candidates** — "explain each decision, now extend it." The only measure that beats overlays, agentic browsers, second devices, virtual cams, and VMs at once. `yes-reliable`.
- [ ] **Ingest the candidate's submitted code** (HackerRank API/OAuth/export — *highest-value missing capability*, currently an open question). Without the code your integrity value is mostly identity + recording + oral round.
- [ ] On the submission, run **paste-with-zero-typing**, edit-history/keystroke-cadence replay, MOSS-style similarity, AI-code detectors — **flag-for-human-review ONLY, never auto-verdict.** Vendor "93%" is self-reported; cf. the Stanford finding that detectors falsely flagged 61% of non-native-English essays. Do not anchor thresholds to vendor accuracy.
- [ ] **Novel/parameterized problem variants** that resist paste-an-answer.

**EPIC: Recording (evidence spine)**
- [ ] `getDisplayMedia({video:{displaySurface:'monitor'}, monitorTypeSurfaces:'include'})` → **HARD-VERIFY `getSettings().displaySurface==='monitor'`; reject + re-prompt** if `'window'`/`'browser'`. Subscribe to `track 'ended'` to timestamp the exact moment they stop sharing.
- [ ] `getUserMedia` webcam+mic on our own origin (straightforward Permissions-Policy), continuous record + periodic stills.
- [ ] **Webcam phone-in-frame object detection** (real, frame-evadable → a flag). **Identity + randomized liveness challenges** up front (show ID on cue, head-turn) — NOT passive gaze.
- [ ] Continuous evidence storage so a human can adjudicate post-hoc — *this is where a companion app adds real value.*

**EPIC: Live alerts / triage**
- [ ] **Behavioral timing**: flag suspiciously flat per-question latency from our own UI events (the Cluely tell). Human review, never auto-fail.
- [ ] **`screen.isExtended`** at start AND polled (catch hot-plug) → multi-monitor flag.
- [ ] VM/RDP/virtual-cam fingerprints + permission-denials → **soft risk score for human triage only.**
- [ ] Server-side correlation → a **multi-signal RISK SCORE that routes high-risk candidates to the mandatory oral round.** Never a binary auto-pass/fail.

**EPIC: Lockdown (deliberately minimal — set expectations)**
- [ ] Fullscreen on "Start exam" click → log every `fullscreenchange` → `fullscreenElement===null` as a *violation event* (tripwire).
- [ ] Optional `navigator.keyboard.lock(['Escape','Tab',...])` on Chromium — **friction + evidence only** (can't beat Ctrl+Alt+Del; 2s-hold-Esc always escapes; no-op on FF/Safari).
- [ ] **Do NOT build:** gaze cheating flags, DevTools detection, `beforeunload` integrity, clipboard/keystroke blocking on our own page, any "we block Cluely/AI browsers" marketing. **Drop entirely.**

**EPIC: Browser gating** — §5: require Chrome/Edge ≥130; block FF/Safari/mobile; special-case Brave; feature-detect (not UA) and re-validate permissions at start; friendly "unsupported browser" wall naming the exact failed check.

**EPIC: Single-session** — gate the exam on a fresh, server-issued nonce; if you ship the extension, do a content-script heartbeat handshake (signed server nonce) and refuse to start if absent — knowing this *detects* removal but can't *prevent* it.

### The one honesty correction for stakeholders
The defensible product is **identity + full-screen evidence recording + multi-monitor flag + behavioral triage → mandatory live oral defense for flagged candidates.** Explicitly **NOT** a lockdown, **NOT** an overlay detector, **NOT** an AI-browser blocker. Pair the honest "from a browser we provably cannot catch overlays / second devices / agentic browsers" with the nuance that **the arms race is shifting** (macOS 15.4+ leaks overlays into capture; agentic browsers have real server-side fingerprints) — so you neither over-promise detection nor over-claim impossibility.

---

## 8. Sources

**Foundational / threat-model ceiling**
- https://www.usenix.org/system/files/sec22-burgess.pdf — "Watching the Watchers," USENIX Security 2022 (all anti-cheat bypassable; VM/webcam/header weaknesses; classifier skin-tone bias)
- https://arxiv.org/abs/2205.03009

**Iframe / framing**
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors
- https://w3c.github.io/webappsec-csp/ — frame-ancestors overrides XFO
- https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html
- https://scrapfly.io/blog/posts/how-to-bypass-akamai-anti-scraping ; https://www.akamai.com/blog/security/bots-tampering-with-tls-to-avoid-detection — JA3/JA4 fingerprinting

**Screen capture / getDisplayMedia**
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/displaySurface
- https://developer.chrome.com/docs/web-platform/screen-sharing-controls
- https://w3c.github.io/mediacapture-screen-share/
- https://github.com/mdn/content/issues/42218 — Safari displaySurface broken (system picker)

**Multi-monitor / kiosk APIs / gating**
- https://developer.mozilla.org/en-US/docs/Web/API/Screen/isExtended ; https://developer.chrome.com/docs/capabilities/web-apis/window-management
- https://caniuse.com/mdn-api_keyboard_lock ; https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock ; https://wicg.github.io/keyboard-lock/
- https://caniuse.com/mdn-api_idledetector ; https://github.com/WICG/idle-detection (Mozilla/Apple declined "harmful")
- https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues ; https://blog.castle.io/how-to-detect-brave-browser-using-http-headers-and-javascript/
- https://github.com/brave/brave-browser/issues/47243 — Brave screen-capture bugs
- https://it.umn.edu/services-technologies/how-tos/proctorio-student-guide — Chrome/Edge-only industry posture

**Page Visibility / focus (theater for our use)**
- https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- https://github.com/Devrill/Bypass-Tab-Switch-Detection ; https://github.com/Transwarp8/PageVisibilityBlocker

**Extension (MV3) capabilities**
- https://developer.chrome.com/docs/extensions/reference/api/tabs ; /windows ; /webNavigation
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- https://developer.chrome.com/docs/extensions/reference/api/debugger (persistent banner — do not ship)

**Overlay / hidden-window (Cluely class)**
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity — WDA_EXCLUDEFROMCAPTURE airtight on Windows
- https://adamsvoboda.net/how-interview-cheating-tools-hide-from-zoom/
- https://www.interviewcoder.co/help?section=undetectability
- **https://developer.apple.com/forums/thread/792152 ; https://github.com/tauri-apps/tauri/issues/14200 — macOS 15.4+ ScreenCaptureKit ignores content-protection (re-verified 2026-06-05)**
- https://honorlock.com/blog/what-is-cluely-how-to-block-it/ ; https://www.talview.com/en/stop-cluely-cheating ; https://techcrunch.com/2025/04/29/startups-launch-products-to-catch-people-using-ai-cheating-app-cluely/

**Webcam gaze accuracy ceiling (why gaze flags are theater)**
- https://par.nsf.gov/servlets/purl/10443673 — calibration-free webcam gaze ~5° offset
- https://arxiv.org/pdf/2508.19544 — WebEyeTrack ~2.3 cm error, degrades with head movement
- https://blog.autoproctor.co/why-we-dont-use-eyeball-tracking-in-our-ai-proctoring/

**Agentic AI browsers (server-side detection exists)**
- https://changes.proctorio.com/november-18-2025-327249 — Proctorio blocks Comet/Atlas
- **https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ ; https://seresa.io/blog/ai-bot-filtering/chatgpt-atlas-and-perplexity-comet-are-already-in-your-analytics — CFNetwork/Darwin UA server-side signatures (re-verified 2026-06-05)**

**SEB header-spoofing lesson**
- https://blog.govardhanchitrada.com/Bypass-Safe-Exam-Browser-Restrictions/ ; https://github.com/UmmItKin/SebBypass

**HackerRank tiers + coding-integrity signals**
- https://support.hackerrank.com/articles/5663779659-proctor-mode ; https://support.hackerrank.com/articles/5973590014-hackerrank-desktop-app-mode
- https://www.hackerrank.com/writing/tab-proctoring-what-it-catches-and-what-it-misses
- https://www.hackerrank.com/writing/how-hackerrank-catches-ai-generated-code-advanced-ml-plagiarism-detection (93% is vendor self-report)
- https://support.codility.com/hc/en-us/articles/15584109019671-Proctoring-Ensuring-Assessment-Integrity-with-Behavioral-Events-Detection (pure-web behavioral logging — the realistic ceiling)

**Live oral defense as the robust mitigation**
- https://werecruit.it/blog/ai-cheating-interviews-2026/ ; https://fabrichq.ai/blogs/interview-cheating-in-2026-the-rise-of-ai-tools-like-cluely-and-interview-coder

---

### Top open questions to resolve before/during the build
1. **Can we obtain the candidate's submitted code** (HackerRank API/OAuth/export)? Highest-value missing capability — without it, integrity value collapses to identity + recording + oral round.
2. **Is the population BYOD or managed/force-install?** This single fact decides whether the extension's allowlist is a cage or a speed-bump — i.e. whether A is "lockdown" or just "better triage."
3. **Hands-on test:** does a content script's isolated-world observation catch paste/copy in HackerRank's Monaco/CodeMirror editor, or is main-world injection needed (and does CSP/Akamai interfere)?
4. **Empirical:** does a *browser* `getDisplayMedia` "monitor" capture on Chrome-on-Sequoia (macOS 15.4+) actually include a content-protected overlay? Verify before relying on or denying it.
5. **Legal/privacy:** webcam + screen recording + biometric-ish storage → GDPR/BIPA-style consent + retention model in your jurisdiction, plus the documented facial-recognition bias liability.
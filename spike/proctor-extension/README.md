# Proctor Extension Spike

A minimal MV3 Chrome extension to (1) test the install flow and (2) prove what an extension CAN/CANNOT see.

## Install — two ways (the contrast IS the lesson)

### A. "Load unpacked" (dev path — works 100%)
1. Open `chrome://extensions`
2. Toggle **Developer mode** ON (top-right)
3. Click **Load unpacked** → select this folder (`spike/proctor-extension/`)
4. Pin it, click the toolbar icon to open the popup.

### B. The packed `.crx` (to feel the self-hosted-install friction)
1. `chrome://extensions`, Developer mode ON
2. Drag `spike/proctor-extension.crx` onto the page.
3. **Expect Chrome to block/warn** ("can only be added from the Chrome Web Store"). This friction is exactly why a self-hosted `.crx` is NOT a student-install path — real options are the Chrome Web Store (BYOD, 2-click "Add to Chrome") or an enterprise force-install policy (lab machines).

> On install you'll see the warning **"Read your browsing history"** — that's the `"tabs"` permission. Students would see this.

## What it proves

- **Popup** → lists every window + every tab (title + URL) across the whole browser → an extension **sees all open tabs/URLs** (in this Chrome profile).
- **Service worker console** (`chrome://extensions` → this extension → "service worker" → Inspect): watch it log every tab switch, new tab, navigation, and "focus left the browser" as you move around.

## CAN vs CANNOT

✅ CAN: all tabs/URLs, active tab, tab switches, new/closed tabs, navigations, focus-leaves-browser; (with a content script) read the HackerRank tab's contents.
⛔ CANNOT: other programs / Task Manager / OS processes, apps outside the browser, transparent overlays (Cluely), a second device, a VM, or tabs in a *different* browser/profile. Seeing OS processes requires a **Native Messaging host** (a separate native binary install) — not "just an extension."

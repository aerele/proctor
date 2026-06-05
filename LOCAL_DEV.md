# Aerele Proctor — Local Test-Instance Guide

A tight edit/test loop for the `proctor` monorepo. Written for the case where **gcloud is NOT installed** and you want to make changes and see them fast. The fast path is **demo mode**, which needs zero backend and zero GCP.

Repo root: `/home/karthi/arogara/proctor` (an npm **workspaces** monorepo: `frontend`, `backend`, `video-worker`). **Run all npm commands from the repo root**, not from `frontend/`.

> This file is local notes (untracked). Delete it any time with `rm LOCAL_DEV.md`.

---

## 1. TL;DR — fastest live, editable instance

```bash
cd /home/karthi/arogara/proctor
npm install                                   # once
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
```

Then open **http://localhost:5173** in **Chrome or Edge** (Chromium-based — `getDisplayMedia` is required and real even in demo mode).

- Student UI: `http://localhost:5173/`
- Admin UI: `http://localhost:5173/admin` — unlock with `dev`.

This runs the full UI with fake sessions/uploads/settings (stored in `localStorage`), no backend, no GCP. Edit any file under `frontend/src/` and the browser hot-reloads instantly.

> `VITE_ADMIN_PASSWORD=dev` is required to use `/admin`: with it unset the admin password defaults to `""` and the **Unlock button stays disabled** until you type something, so you can never actually log in.

---

## 2. What runs locally vs. what needs GCP

| Capability | Local (no GCP)? | How |
|---|---|---|
| Frontend SPA (student + admin UI), HMR | ✅ Yes | `VITE_DEMO_MODE=true npm run dev` |
| Sessions, uploads, heartbeats, events, admin settings (in demo mode) | ✅ Yes (faked) | `src/api.ts` stubs them; settings persist in `localStorage` |
| Screen / camera / mic capture (`getDisplayMedia`/`getUserMedia`, `MediaRecorder`) | ✅ Yes (real browser API) | Chromium browser; works over `http://localhost`. **Demo mode does NOT stub this** |
| Frontend typecheck / build | ✅ Yes | `npm run lint`, `npm run build` |
| Backend unit tests | ✅ Yes (offline, no env) | `npm run backend:test` |
| Backend HTTP server **boots** | ✅ Yes | `npm start --workspace backend` — GCP clients are lazy; 404/OPTIONS/400/401 respond offline |
| Backend **data routes** (Firestore) | ⚠️ Emulator | Firestore emulator needs gcloud — **not installed** |
| Backend **storage routes** (`/api/upload-url`, `/api/session/end`, `/api/admin/sessions`) — GCS v4 signed URLs | ❌ No | No GCS emulator; v4 signing needs **real** credentials |
| Real evidence upload end-to-end | ❌ No | Needs real Firestore + GCS bucket + ADC |
| video-worker / merge CLI (review videos) | ❌ No | Needs real GCS buckets; CLI also needs gcloud. Not part of the dev loop |
| Full GCP deploy (`deploy-gcp.sh` ×3) | ❌ No | All three scripts require **gcloud** — not installed |

**Bottom line:** the laptop-runnable paths are (a) demo mode and (b) frontend against an already-deployed backend. A meaningful full local stack with real evidence upload is **not** achievable here without gcloud/emulators/credentials — see §4(c).

---

## 3. Setup steps

1. **Install Node deps from the repo root** (npm workspaces hoists everything into `proctor/node_modules`; there is no separate `backend/node_modules`):

   ```bash
   cd /home/karthi/arogara/proctor
   npm install
   ```

   Verify the frontend dev binary exists before starting (the root `.bin/vite` symlink may be absent even when the real binary is present):

   ```bash
   ls frontend/node_modules/vite/bin/vite.js && echo "vite OK"
   ```

   If `npm run dev` ever fails with "vite: command not found", re-run `npm install` at the root.

2. **Env files — optional for demo mode.** The fastest loop passes vars inline (TL;DR). If you prefer a file, create **`frontend/.env.local`** (gitignored). Two mutually-exclusive shapes:

   **For demo mode (no backend):**
   ```dotenv
   VITE_DEMO_MODE=true
   VITE_ADMIN_PASSWORD=dev
   ```

   **For a real/deployed backend (do NOT also set demo mode):**
   ```dotenv
   VITE_API_BASE_URL=https://YOUR_BACKEND_CLOUD_RUN_URL
   VITE_ADMIN_PASSWORD=<the deployed ADMIN_PASSWORD>
   ```

   > These are all `VITE_*` and are **build/dev-time** — read by `src/api.ts` (`VITE_API_BASE_URL` line 3, `VITE_DEMO_MODE` line 4, `VITE_ADMIN_PASSWORD` line 6). There is **no** Vite dev proxy, so a real backend URL must be a full absolute, CORS-enabled URL.
   > `frontend/.env.local` (Vite) and `./.env.deploy.local` (shell vars for gcloud deploy) are different files for different layers and are **not** interchangeable. You do not need `.env.deploy.local` for any local run.

Confirmed toolchain on this machine: node `v20.19.0`, npm `10.8.2`, ffmpeg and docker present, **gcloud absent**.

---

## 4. The three run modes

### (a) Demo mode — no backend, recommended

```bash
cd /home/karthi/arogara/proctor
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
```

- Serves on **http://localhost:5173** (bound to `0.0.0.0`, so it's also reachable on the LAN).
- `src/api.ts` short-circuits every network call: fake `session_id` (`crypto.randomUUID`), fake `start_ip` `demo.local`, hardcoded `upload_config` (chunk 20s, max_width 1280, max_frame_rate 5, heartbeat 15s), uploads resolve to `demo://` URLs with no network, heartbeats return `ip_changed:false`, events/review-files are swallowed. Admin settings read/write go to `localStorage` (`aerele-proctor-demo-settings`).
- **Caveat:** screen/camera/mic capture is the one thing demo mode does **not** fake — it's real browser API. Use Chrome/Edge; on `localhost` it works over plain http.

### (b) Frontend against a deployed backend — no gcloud needed

Requires that someone has already deployed the backend (you can't deploy from here without gcloud).

```bash
cd /home/karthi/arogara/proctor
# frontend/.env.local must contain VITE_API_BASE_URL=https://...  (and NOT VITE_DEMO_MODE)
npm run dev
```

- `api.ts` strips a trailing slash and fetches `${VITE_API_BASE_URL}${path}`.
- The backend must send CORS headers for the dev origin (deployed backends use `PUBLIC_APP_ORIGIN=*`, which allows it).
- Set `VITE_ADMIN_PASSWORD` to the deployed `ADMIN_PASSWORD` to use `/admin` against the real backend.

### (c) Full local stack (backend locally + frontend) — only PARTIALLY achievable here

**The backend HTTP server boots fine locally, but you cannot exercise a real end-to-end evidence-upload flow on this machine.**

```bash
# Terminal 1 — backend (boots with zero GCP)
cd /home/karthi/arogara/proctor
EVIDENCE_BUCKET=local-proctor-evidence ADMIN_PASSWORD=localadmin PUBLIC_APP_ORIGIN='*' \
  npm start --workspace backend          # functions-framework --target=api, port 8080
```

```bash
# Terminal 2 — frontend pointed at the local backend
# frontend/.env.local: VITE_API_BASE_URL=http://localhost:8080  (no VITE_DEMO_MODE)
cd /home/karthi/arogara/proctor
npm run dev
```

What actually works / fails:

- **Boots cleanly** with no credentials. `new Firestore()` / `new Storage()` are lazy. Offline-verified to respond: 404, OPTIONS preflight, 400 field-validation, 401 admin-auth.
- **Firestore-backed routes** (admin settings, session-start gate, event/heartbeat counters, validate-end/end metadata) need real ADC + project, or the **Firestore emulator** (`gcloud emulators firestore start`) — gcloud not installed. Without a project id you get a runtime 500 `Unable to detect a Project Id in the current environment` (at request time, not boot).
- **GCS signed-URL routes** (`/api/upload-url`, `/api/session/end`, `/api/admin/sessions`) are the hard blocker: **no GCS emulator exists**, v4 signing requires real credentials. They will not produce usable URLs offline.
- **Port collision:** backend defaults to **8080**; the Firestore emulator also defaults to 8080. Give them distinct ports (`PORT=...`).

**Verdict:** use (c) only to develop/inspect non-storage backend routes (and only if you install gcloud for the Firestore emulator). For real upload flows, deploy to GCP. For everything else, prefer demo mode (a).

> Verify the boot claim: start the backend, then `curl -i http://localhost:8080/nope` (expect 404) and `curl -i -X OPTIONS http://localhost:8080/api/session/start` (expect a CORS preflight response).

---

## 5. Inner dev loop

Fastest loop: **`VITE_DEMO_MODE=true npm run dev`**, then save any `.ts`/`.tsx` under `frontend/src/` — Vite HMR updates the browser instantly (port 5173).

On-demand gates (all from repo root):

```bash
npm run lint          # frontend: tsc -b --pretty false  → TYPECHECK only (see note)
npm run build         # frontend: tsc -b && vite build    → typecheck + bundle to frontend/dist
npm run backend:test  # backend:  node --test test/*.test.mjs  (offline, no env)
npm --workspace video-worker run check   # node --check src/server.mjs (syntax only)
```

Notes:
- **`npm run lint` is a misnomer** — it runs `tsc -b` (TypeScript typecheck), **not** ESLint. There is **no** ESLint/Prettier and **no** style gate anywhere; only type errors are caught.
- **No frontend tests** (no Vitest/Jest). The only automated test is `backend/test/sanitize.test.mjs`, which re-implements the username-normalization regex inline (does **not** import handler source) — treat it as documentation of the slug convention, not coverage.
- **No `preview` script.** To serve a production build, after `npm run build` run `npx vite preview` inside `frontend/`.

---

## 6. Admin & student flows locally (demo mode)

**Routing has no router** — `App.tsx` selects admin vs. student purely by `window.location.pathname.startsWith('/admin')`. The Vite dev server's SPA fallback makes `http://localhost:5173/admin` work directly.

**Admin password mechanism:**
- Compared **client-side only** against `import.meta.env.VITE_ADMIN_PASSWORD` (`AdminApp.unlockAdmin` + `api.ts`). Defaults to `""` if unset.
- It only hides the admin UI pre-unlock; it is **not** real security — the real backend enforces admin via the `x-admin-password` header.
- With `VITE_ADMIN_PASSWORD` unset, the **Unlock button stays disabled** until the field is non-empty — so set `VITE_ADMIN_PASSWORD=dev` to log in.

**Admin flow:**
1. Open `http://localhost:5173/admin`, unlock with your `VITE_ADMIN_PASSWORD` (e.g. `dev`).
2. Fill **Start time**, **End time**, **Contest URL**, **passcode**, and **end code**, then click **Save**. In demo mode this persists to `localStorage` key `aerele-proctor-demo-settings`.
3. Set a **wide** start/end window — the student start is blocked unless "now" is within `start_at..end_at`.

**Student flow:**
1. Open `http://localhost:5173/`.
2. Click **Start proctoring** using the **passcode** you set (within the time window).
3. The browser prompts for screen + camera/mic — this is **real**. Pick **Entire Screen**: selecting a tab/window triggers a fatal error by design (`displaySurface !== 'monitor'`).
4. **End test** using the **end code** you set in admin.

**Reset the demo gate:** clear the `aerele-proctor-demo-settings` key in DevTools → Application → Local Storage.

---

## 7. Gotchas & caveats (consolidated)

- **Run from the repo root**, not `frontend/` — it's an npm workspaces monorepo. Backend deps live in `proctor/node_modules` (no `backend/node_modules`).
- **`vite` binary:** the root `node_modules/.bin/vite` symlink may be missing; verify `frontend/node_modules/vite/bin/vite.js` exists, and re-run `npm install` at the root if `npm run dev` can't find vite.
- **Frontend config is build/dev-time, not runtime.** `VITE_API_BASE_URL` / `VITE_DEMO_MODE` / `VITE_ADMIN_PASSWORD` are read when the dev server starts (or baked in at `vite build`). Changing them requires restarting `npm run dev`. The production nginx image reads no env at runtime.
- **No Vite dev proxy.** A real backend must be a full absolute, CORS-enabled URL; there is no same-origin `/api` proxy.
- **Don't set both** `VITE_DEMO_MODE=true` and `VITE_API_BASE_URL` expecting the real backend — demo mode short-circuits the network. If neither is set, every API call throws `VITE_API_BASE_URL is not configured.`
- **Admin password ships in client JS** — semi-public, UI-gate only; real auth is the backend `x-admin-password` check.
- **Screen capture is real even in demo mode**: needs a Chromium browser + a user gesture; works over `http://localhost`; **must** select "Entire Screen".
- **Ports:** dev server **5173**; backend / video-worker / nginx all default to **8080**. Backend and the Firestore emulator both default to 8080 — distinct ports if both run.
- **Dev server binds `0.0.0.0`** (`vite --host`), so it's exposed on the LAN, not just localhost.
- **Backend `npm start` quirk:** use `npm start --workspace backend` (or `npx @google-cloud/functions-framework --target=api`). Do **not** run bare `npx functions-framework` — it resolves the wrong legacy unscoped package.
- **video-worker and the merge CLI are not in the dev loop** — they produce review videos for finished sessions, need real GCS buckets. Skip them for local testing.
- **gcloud is not installed**, so the Firestore emulator path and all three `deploy-gcp.sh` scripts are unavailable until you install + auth the Google Cloud SDK.

**Key files for editing:** `frontend/src/api.ts` (all backend calls + the demo stub + the three env reads), `frontend/src/App.tsx` (routing + admin unlock), `frontend/src/useProctorRecorder.ts` (real capture/MediaRecorder/heartbeat — the only part demo mode does not stub), `frontend/src/types.ts` (API shapes), `frontend/vite.config.ts` (port 5173, no proxy).

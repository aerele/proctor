# frontend/ — student recorder + admin console (React + Vite + TS + Tailwind)

A single React app (`src/App.tsx`) that splits on the URL path: `/` is the
**student proctor recorder**, `/admin` is the **admin console** (live stats, Live
Alerts Console, per-username evidence review, schedule + alert-type settings).
Built with Vite, TypeScript, and Tailwind; deployed as a static site on Cloud Run
behind nginx.

- `src/App.tsx` — both apps. Student: registration → screen-share recording (it
  **refuses to record** anything but an Entire-Screen / `monitor` surface),
  guided step banner, resume-after-reload, invalid-share/end-failure inline
  recovery, tab-close beacon. Admin: 5s auto-poll Live
  stats + Live Alerts (archive, room/severity/source filters, video deep-links),
  remote session actions (approve/lock/unlock/bypass/end), alert-type toggles.
- `src/useProctorRecorder.ts` — the recorder engine: `getDisplayMedia` capture,
  chunked uploads via signed URLs, heartbeat loop (sends the composite
  `recording_state`), screen-share-stopped detection, server-status self-stop.
- `src/api.ts` — all backend calls **and** the `VITE_DEMO_MODE` shim (a full
  localStorage-backed fake of the session/alert lifecycle so the whole UI runs
  with no backend). Also the admin-unlock hashing (`VITE_ADMIN_PASSWORD_HASH`).
- `src/types.ts` — the shared `Alert` contract + all request/response types.
- `deploy-gcp.sh` — builds with `VITE_API_BASE_URL` + a **sha256 of**
  `ADMIN_PASSWORD` (`VITE_ADMIN_PASSWORD_HASH`, so the plain password is never in
  the bundle) and deploys to Cloud Run.
- `nginx.conf` / `Dockerfile` — static hosting.

Run local: `npm run dev` (needs `VITE_API_BASE_URL`), or `VITE_DEMO_MODE=true npm
run dev` for backend-free UI. Type-check/lint: `npm run lint`. Build: `npm run
build`. Env vars: `VITE_API_BASE_URL`, `VITE_DEMO_MODE`, `VITE_ADMIN_PASSWORD`,
`VITE_ADMIN_PASSWORD_HASH` — full table in the top-level [`README.md`](../README.md).

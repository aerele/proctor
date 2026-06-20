# Contributing

Thanks for your interest in Aerele Proctor. Contributions are welcome.

## Local development

See **[LOCAL_DEV.md](./LOCAL_DEV.md)** for the full setup: prerequisites, the
offline demo, running against a real backend, and the deploy story.

Node **22** is expected (`engines.node >= 22`; an `.nvmrc` is provided — run
`nvm use`). Install once at the workspace root:

```bash
npm ci
```

## Run the tests before opening a PR

```bash
# backend (node:test)
cd backend && npm test

# frontend (vitest)
cd frontend && npx vitest run

# frontend type-check + production build
cd frontend && npx tsc -b && npx vite build
```

CI runs the backend and frontend suites plus the frontend build on every push
and pull request, so please make sure they pass locally first.

The optional `monitoring/` poller has its own offline suite
(`python3 monitoring/test_monitoring.py`); the fixture-backed checks skip on a
fresh clone (their data is gitignored), so it exits 0 without setup.

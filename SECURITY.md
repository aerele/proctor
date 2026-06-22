# Security

## Reporting a vulnerability

If you discover a security vulnerability in Aerele Proctor, please report it
**privately** rather than opening a public issue.

**Preferred channel:** GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).
Open the repository's **Security** tab and choose **Report a vulnerability** to
open a private advisory visible only to you and the maintainers. If that option
is unavailable to you, contact the maintainers privately through the repository
(for example, by reaching the repository owner via their GitHub profile) instead
of filing a public issue.

Please include reproduction steps and the affected component (`proctor-api`,
`proctor-web`, `proctor-eval`, or the optional
`monitoring/` poller).

We will acknowledge the report and work with you on a fix and disclosure
timeline. Please give us a reasonable window to remediate before any public
disclosure.

## Threat model — what this product is and is not

Aerele Proctor is **honest, browser-based proctoring**: evidence collection and
triage, not lockdown. A plain web app **cannot** force-close tabs, enumerate
other tabs, continuously read the OS clipboard, see a second device, or detect an
overlay on another monitor — no browser app can without a managed extension or
endpoint agent. Integrity rests on **human review of recorded evidence** plus a
live signal feed; treat alerts as triage for review, never as automatic
disqualification. See the README and `docs/proctoring-research.md` for the full
threat model.

## Operator security responsibilities

This is self-hosted software. When you deploy it, you are responsible for:

- **Secrets.** Never commit real secrets. All secret-bearing files are
  gitignored (`.env`, `.env.*`, `*.bak`, `*.pem`, service-account keys). Use the
  `*.env.example` templates. Generate strong values
  (`openssl rand -base64 32`) for `ADMIN_PASSWORD`, `ALERTS_INGEST_API_KEY`,
  `RETENTION_SWEEP_API_KEY`, and `INVIGILATOR_PASSWORD`.
- **Closed-by-default ingest.** `POST /api/alerts` and
  `POST /api/admin/retention-sweep` reject every request when their API key is
  unset. Keep them closed until you intend to use them.
- **CORS.** `PUBLIC_APP_ORIGIN` defaults to `*` for first bring-up. Lock it to
  the exact frontend URL in production.
- **Frontend password hashing.** Plain admin/invigilator passwords are never
  shipped in the production bundle — `frontend/deploy-gcp.sh` bakes only the
  SHA-256 hashes and verifies them before deploy. Always deploy the frontend
  through that script; ad-hoc builds skip the hash bake and verification gate.
- **Candidate PII.** Recordings, rosters, and identity-bearing scorecards are
  sensitive personal data. Configure the evidence-retention lifecycle and daily
  sweep (see `docs/DEPLOY.md`), restrict bucket and Firestore access, and comply
  with the data-protection law applicable to your candidates.
- **Code execution.** Run/Submit runs candidate code on Judge0. Prefer the
  managed RapidAPI Judge0, or isolate any self-hosted Judge0 instance.

## Data handling in this repository

This public repository contains **no candidate PII**. All screenshots under
`docs/assets/` use synthetic test personas (e.g. "Asha Rao / TEC001 / Test
Engineering College"). Real candidate data, recordings, and operational notes are
kept out of the repository (gitignored `junk/`, `local-notes/`, and the
`monitoring/.data/` outputs).

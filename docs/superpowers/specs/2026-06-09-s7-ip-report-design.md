# S7 — IP-address report (IP-wise count of logged-in users) — Design

**Status:** Night-run stretch item 7 (locked scope: `night-run/MORNING-NOTES.md` → STRETCH 7; intent: platform design §8 "IP-address report: admin screen/status showing **IP-wise count** of logged-in users (catch off-campus testing); group/flag clusters").
**Author:** Ram (architect subagent). **Date:** 2026-06-09.
**Paired plan:** `docs/superpowers/plans/2026-06-09-s7-ip-report.md`.

---

## 1. Vision

The admin opens an **IP report** tab and sees one row per client IP address, biggest clusters first: how many distinct candidates and sessions sit behind each IP, their rooms, statuses, and who they are. On campus, each lab collapses to a handful of NAT IPs with many users — so **a candidate on an IP nobody else uses** (off-campus / proxy candidate) and **an unexpected IP carrying many candidates** (a proxy box) both stand out at a glance. Sessions whose IP changed mid-exam are marked. The report is a *signal surface*, not a verdict engine: interpretation stays with the admin.

## 2. How the system works today (studied 2026-06-09)

**IP capture and storage ALREADY EXIST — S7 builds only the aggregation + UI on top:**

- `getClientIp(req)` in `backend/src/handler.mjs` reads `x-forwarded-for` (Cloud Run sets it) with a socket-address fallback, normalized via `normalizeIp` (strips `::ffff:`, caps 80 chars).
- **Session start** (`startSession`) stores `start_ip`, `current_ip`, `ip_change_count: 0` on the session doc and logs `start_ip` into the session's GCS JSONL.
- **Every heartbeat** (`recordHeartbeat`, 15 s interval) refreshes `current_ip`, increments `ip_change_count` on a change, stamps `last_ip_change_at`, writes an `ip_address_changed` JSONL event, and raises the existing `ip_changed` proctor alert.
- Admin aggregation endpoints (`adminStats`, `adminSessionsList`) share a pattern S7 mirrors: `requireAdmin` → contest-scoped Firestore query capped at `SESSIONS_QUERY_LIMIT` (2000) → in-memory filter/aggregate → bounded response.
- Admin console (`frontend/src/App.tsx` `AdminApp`) is tab-based (`AdminView` union + `AdminTab` nav); the global contest filter banner re-scopes every tab; `api.ts` wrappers return `null` on 404 so a not-yet-deployed endpoint degrades gracefully; demo mode derives admin data from the shared `DEMO_ALL_SESSIONS` population.

**One trust gap found:** `getClientIp` takes the **first** `x-forwarded-for` entry. On Cloud Run the ingress proxy **appends** the real client IP as the **last** value — earlier entries arrive in the client's own request and are **spoofable**. Today that only skews a warning alert; for a proxy-detection report it would let a colluding candidate disguise their IP with one header.

## 3. Decisions

1. **No new capture, no session-doc schema change.** `start_ip`/`current_ip`/`ip_change_count` already exist (§2). S7 adds aggregation + UI only. *(The night-run item text said "find where the backend can capture… store it on the session doc" — done; verified in code.)*
2. **Harden `getClientIp` to take the LAST `x-forwarded-for` hop** (the one Cloud Run's proxy appended), not the first. Single shared function, ~3 lines; existing tests use single-value headers (first == last) so nothing breaks; the `ip_changed` alert becomes more truthful too. *(Flagged as a judgment call for morning review — it changes a shared helper's behavior for multi-hop headers.)*
3. **Grouping key = `current_ip || start_ip || "unknown"`** (`reportIp`). The most recent IP is the live signal; sessions that never heartbeat fall back to their start IP; pre-capture legacy docs group under `"unknown"` instead of vanishing.
4. **Aggregation is a pure module, `backend/src/ipReport.mjs`** — matches the repo's module split (`problems.mjs`, `execQueue.mjs`), keeps `handler.mjs` churn tiny (import + route + ~20-line `adminIpReport`), is directly unit-testable without the handler fakes, and minimizes parallel-edit collision with the other night items.
5. **`scope=live` (default) vs `scope=all`.** "Logged-in users" (the backlog ask) = non-ended sessions (`active`/`locked`/`pending_approval`); `all` adds ended sessions for after-the-exam forensics. Two values only — no per-status matrix.
6. **Server computes counts; nobody auto-flags.** Per-IP: distinct-user count, session count, per-status counts, distinct rooms, and a bounded candidate sample. Sorting puts multi-user clusters first; the UI tints multi-user rows and marks mid-exam IP changes. No "suspicious" verdicts — on campus a 200-user NAT IP is *normal*, remote it isn't; the admin knows which exam they're running.
7. **Bounded response:** ≤200 IP groups (`IP_REPORT_IPS_LIMIT`, sorted first so the biggest clusters always make the cut, `ips_truncated` flag), ≤25 candidate rows per IP (`IP_REPORT_CANDIDATES_LIMIT`, `candidates_truncated` + "+N more" in the UI). Inputs already capped by `SESSIONS_QUERY_LIMIT` (2000), same as every sibling admin endpoint.
8. **New admin tab "IP report"** (`AdminView` member `"ips"`), not a Live-stats add-on: the report is a table, not a counter card, and a separate view keeps `App.tsx` edits additive (S5 is concurrently editing the Live-stats dashboard). Load on tab open + manual Refresh; **no 5 s auto-poll** (forensic view, not a liveness monitor). The global contest filter re-scopes it like every other tab.
9. **Demo mode derives from the shared `DEMO_ALL_SESSIONS` population** plus a deterministic per-session IP assignment (room → NAT IP, with three overrides painting the anomalies: an off-campus active candidate, an ended outlier, one mid-exam IP change). Grouping logic lives in a pure, vitest-covered `frontend/src/ipReport.ts` so demo numbers reconcile with the demo stat cards by construction.

## 4. Data model

**No new collections. No new fields.** Read-only over existing session docs:

| Field (session doc) | Written by (existing) | Used as |
|---|---|---|
| `current_ip` | heartbeat (start seeds it) | primary grouping key |
| `start_ip` | session start | fallback key; shown per candidate |
| `ip_change_count` | heartbeat increment | per-candidate marker + summary count |
| `username_norm` | session start | distinct-user counting |
| `status`, `room`, `contest_slug`, `created_at`, `hackerrank_username`, `name`, `session_id` | session lifecycle | filters, per-status counts, candidate rows |

## 5. API surface

### New: `GET /api/admin/ip-report` (admin auth: `x-admin-password`)

Query params (all optional): `contest_slug` (server-side equality filter, same as `adminStats`), `room` (normalized via `normalizeRoomFilter`, in-memory filter), `scope` = `live` (default) | `all`.

Response `200`:

```json
{
  "contest_slug": "mcet-june-2026",
  "room": null,
  "scope": "live",
  "total_sessions": 412,
  "distinct_ips": 6,
  "multi_user_ips": 4,
  "ip_changed_sessions": 2,
  "ips_truncated": false,
  "ips": [
    {
      "ip": "203.0.113.10",
      "sessions": 201,
      "users": 200,
      "active": 198, "locked": 1, "pending_approval": 2, "ended": 0,
      "rooms": ["Lab A-1", "Lab A-2"],
      "candidates": [
        { "session_id": "…", "hackerrank_username": "Arav_M", "name": "Arav Menon",
          "room": "Lab A-1", "status": "active", "created_at": "…",
          "start_ip": "203.0.113.10", "ip_change_count": 0 }
      ],
      "candidates_truncated": true
    }
  ]
}
```

Sorting: `users` desc → `sessions` desc → `ip` asc (deterministic). `multi_user_ips` counts IPs with ≥2 distinct users **before** the 200-group cap. Candidate rows sort `created_at` desc (newest session first).

### Error handling

| Condition | Response |
|---|---|
| Missing/wrong admin password | `401 Unauthorized` |
| `scope` not `live`/`all` | `400 scope must be live or all` |
| Session docs missing IP fields (legacy) | grouped under `"unknown"` — never an error |
| Endpoint not deployed (frontend) | `fetchIpReport` returns `null` on 404 → tab shows a "not available" note (mirrors `fetchSessionsList`) |
| Other fetch errors | surfaced in the admin console's existing error banner |

### Changed: `getClientIp` (shared helper)

Takes the **last** comma-separated `x-forwarded-for` hop (the value Cloud Run's proxy appended) instead of the first; socket-address fallback unchanged; `normalizeIp` unchanged. Affects `start_ip`/`current_ip` capture and the `ip_changed` alert only when a client sends a forged multi-hop header — i.e. it stops the forgery.

## 6. UI behavior

**New admin tab "IP report"** (icon `Network`, after Sessions in the nav). The view (`IpReportView`):

- **Header card:** title + interpretation hint ("many candidates on one unexpected IP, or a candidate on an IP no one else uses, is a proxy/off-campus signal — a shared campus NAT is normal"), the global contest slug when set, a **Refresh** button (existing button style, spinner while loading), and a **Scope** `FilterSelect` — "Logged-in (live)" / "All sessions". Scope changes reload server-side (explicit-value pass-through, same stale-state dodge as the Sessions view).
- **Summary line** (in the header card, from the response): `N distinct IPs across M sessions · K multi-user IPs · J sessions with a mid-exam IP change`.
- **Table**, one row per IP, pre-sorted by the server: `IP address` (mono) | `Users` | `Sessions` | `Status` (compact "198 live · 1 locked · 2 pending · 0 ended", zero-count parts omitted) | `Rooms` (joined list, `—` when empty) | `Candidates` (username chips; a chip gains a small warning icon when that session's `ip_change_count > 0`; hover title shows name + status + change count; `+N more` when truncated). Rows with `users ≥ 2` get a warning tint (`bg-warning/5`) — the cluster highlight.
- **States:** 404 → warning note "endpoint not deployed yet"; `null` report → "Loading…/No report loaded yet."; empty `ips` → "No sessions match this scope."; `ips_truncated` → footer note.
- **Demo mode:** fully works offline — Lab A-1 ↦ `203.0.113.10`, Lab B-2 ↦ `203.0.113.11`, plus `Sneha_B` active from `198.51.100.42` (the off-campus signal), `Vikram_T` ended from `192.0.2.77` (visible under scope=all), and `Divya_P` with one mid-exam IP change.

## 7. New modules

- `backend/src/ipReport.mjs` — pure: `reportIp(doc)`, `buildIpReport(docs)`, the two cap constants. No I/O, no env.
- `frontend/src/ipReport.ts` — pure, vitest-covered: `groupIpEntries(rows)`, `summarizeIpEntries(entries, rows)`, same caps; used by the demo branch of `fetchIpReport`.

## 8. Out of scope (deliberate)

- **No automatic flag/verdict thresholds** (Decision 6) — that is Slice-4 analytics territory.
- **No GeoIP / ASN / "expected campus IP range" configuration** — pure observed-IP grouping tonight; an allowlist of expected ranges is a natural later add.
- **No room filter UI on the report tab** (the endpoint accepts `?room=` and it is tested, but the per-IP Rooms column covers tonight's need; wiring the dropdown is a later nicety).
- **No auto-poll** on the tab (Decision 8), no CSV export, no per-IP drill-down view beyond the inline candidate chips.
- **No changes to the `ip_changed` alert**, to `recordHeartbeat`, `startSession`, or any S2/S3/S4/S5-touched function — S7's only shared-code edit is the `getClientIp` body.
- **No IP display on student-facing screens** (privacy: candidates never see other candidates' IPs; the report is admin-auth only).

## 9. Test strategy

- **Backend** (`backend/test/ipReport.test.mjs`): pure `buildIpReport`/`reportIp` tests (grouping, `current_ip`→`start_ip`→`unknown` fallback, distinct-user dedupe across multi-session users, status counts, room dedupe+sort, cluster-first ordering with deterministic tie-breaks, 25-candidate cap + truncation flag, `multi_user_ips`/`ip_changed_sessions` summaries) — no handler import needed; PLUS endpoint tests via the standard node:test harness (env-before-import, `?ipreport` cache-buster, pasted fakes, `__setClientsForTest`): 401 without password, scope default excludes ended, `scope=all` includes them, `contest_slug` + `room` filters, bad scope → 400, and the **multi-hop `x-forwarded-for` test** (start with `"1.2.3.4, 9.9.9.9"` → stored `start_ip` is `9.9.9.9`) that locks Decision 2.
- **Frontend** (`frontend/src/ipReport.test.ts`, vitest): mirrors the pure grouping semantics (grouping, dedupe, sorting, caps, summary math, `unknown` bucket).
- **Integration (browser, demo mode):** unlock admin → IP report tab → both room-NAT clusters render tinted with candidate chips, `198.51.100.42` shows the lone off-campus candidate, scope=All adds the ended outlier, summary counts the one IP-change session; screenshot to `night-run/evidence/s7-ip-report.png`.

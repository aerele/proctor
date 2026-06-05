# Reference — prior iframe/proxy research (forwarded by Karthi)

Source: Karthi's earlier **Vel Bridge v2 / Proxy Mode** work (SIHMA clone). Forwarded 2026-06-04.
Kept verbatim as reference for the proctor iframe/lockdown decision.

## Direct iframe of the original URL on a different host — restrictions
1. **May not load at all** — `X-Frame-Options: DENY/SAMEORIGIN`, CSP `frame-ancestors`; many login/auth pages intentionally block iframe embedding.
2. **Parent cannot inspect/control it** — same-origin policy; cannot read iframe DOM, `contentDocument`, HTML, scroll, page state. Mostly only `postMessage`, and only if the iframe cooperates.
3. **Screenshots/canvas capture fail** — cross-origin content taints canvas; `html2canvas`/canvas cannot read/render it.
4. **Cookies/storage separated** — iframe domain has its own cookies/localStorage/IndexedDB; third-party-cookie/SameSite rules can break logged-in sessions inside the iframe.
5. **Network/console monitoring limited** — without DevTools/extension/proxy, cannot reliably capture requests, console logs, JS errors.

## What PROXYING gave (route target through Vel so it's same-origin)
- iframe became same-origin → DOM access
- canvas/html2canvas screenshots possible
- strip `X-Frame-Options`, CSP, COOP/COEP headers
- inject monitoring JS; capture console logs, JS errors, fetch/XHR
- rewrite assets/links/forms so everything stays inside the proxy
- compare original vs clone in same-origin iframes
- real user browser rendering (not unreliable headless Chrome)
- server-side cookie jar; proxy can set outbound Origin/Referer to target

## Proxying — disadvantages / limitations
1. **OAuth / external login not supported cleanly** — `redirect_uri` points to the real site; providers validate redirect URIs strictly and often block iframe login. Planned workaround was "detect OAuth links / import cookies" UI.
2. **`window.location` shows the proxy URL** — site JS sees `vel-host/proxy/...`; hostname-checking sites detect/break.
3. **JS-created URLs may escape rewriting** — static URLs rewritable; runtime-generated ones need interception.
4. **Third-party iframes are messy** — YouTube/Maps/social widgets may render but not appear in screenshots; domain-locked API keys fail.
5. **WebSockets need special handling** — monkey-patch `WebSocket` + a WS proxy endpoint.
6. **Target service workers must be blocked** — otherwise they conflict with proxy behavior.
7. **SRI/base/meta-CSP issues** — must strip/rewrite `<meta http-equiv="Content-Security-Policy">`, `integrity="..."`, `<base href>`.
8. **Rate limiting / IP reputation** — all requests come from the proxy server IP; hostile sites rate-limit/block.

**Short answer (Karthi's):** direct iframe is okay only for *passive display*. Proxying makes it inspectable/screenshot-able/controllable same-origin — but breaks/complicates auth, hostname-sensitive apps, third-party embeds, WebSockets, and anti-proxy logic.

---

## Applying this to HackerRank (our case) — verdict

Proxy mode is the only way to get a same-origin, inspectable embed of the contest. But every one of its
disadvantages is **triggered hard** by HackerRank, so it is **not a viable path for a live contest**:

- **Login = OAuth + auth pages** (Google sign-in / HackerRank auth) → disadvantage #1, the worst one. Students log in to HackerRank; proxied OAuth redirect_uri + iframe-blocked login break it.
- **Akamai WAF** already returns "Access Denied" to non-standard clients → disadvantage #8 (IP reputation / anti-proxy) is immediate and severe.
- **The coding IDE is WebSocket-heavy** (live code execution, autosave) → disadvantage #5.
- **Hostname checks + runtime URLs + service workers** on a large app like HackerRank → disadvantages #2, #3, #6.
- **ToS/ethics:** proxying and header-stripping a third-party exam platform we don't own is ToS-risky and fragile (breaks on every HackerRank deploy).

**Conclusion:** proxy mode is powerful for cloning a site we want to fully own/inspect, but it is the wrong
tool for live-proctoring a contest hosted on a hardened third party. It does **not** rescue the iframe
approach. The realistic lockdown paths remain: **(A) browser extension** for real control, or **(C)
web-only evidence-first**. See `FINDINGS.md`.

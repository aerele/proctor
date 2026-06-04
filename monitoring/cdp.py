#!/usr/bin/env python3
"""cdp — dependency-light Chrome DevTools Protocol client for UNATTENDED fetching.

Purpose
-------
Drive the user's already-running, authenticated Chromium (remote-debugging on
http://127.0.0.1:9222) from a plain Python process — NO browser automation
framework, NO chrome-devtools MCP, NO agent in the loop. This is what makes the
poller unattended: it loops on its own and fetches via this client.

It opens its OWN new tab (Target.createTarget) pointed at a hackerrank.com URL,
attaches to it (flattened session), waits for load, runs a same-origin async
fetch-JS expression via Runtime.evaluate (awaitPromise + returnByValue), and
returns the parsed JSON. At the end it closes ONLY the tab it created.

NON-DISRUPTIVE GUARANTEES (hard requirements)
---------------------------------------------
  * Uses the browser-level WebSocket endpoint only to *create* and *attach to*
    its own target, and to close that target. It never enumerates, navigates,
    activates, or closes any pre-existing tab.
  * The created target's id is remembered; close() closes exactly that id.
  * If :9222 is unreachable (or the WS handshake/CDP fails), raises CDPError so
    the caller (acquire.LiveAcquirer / poller) can fall back to fixtures.

Dependency policy
-----------------
Pure stdlib. A `websocket-client` package happens to be installed on this box,
but we deliberately DO NOT import it: CDP's WebSocket is trivial (handshake then
text frames carrying JSON {id,method,params}), so we hand-roll a minimal RFC6455
client over `socket`. That keeps `monitoring/` import-free of third-party deps and
portable to any machine with Python 3 + a debuggable Chrome.

This module performs NO file I/O and holds NO PII; callers own persistence.
"""
import base64
import http.client
import json
import os
import socket
import struct
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_DEVTOOLS = "http://127.0.0.1:9222"
# A same-origin page is required so credentialed fetch() carries the HR session
# cookies. The leaderboard page is read-only and always present for any contest.
DEFAULT_BLANK_HR_URL = "https://www.hackerrank.com/dashboard"


class CDPError(RuntimeError):
    """Any failure talking to Chrome (unreachable, handshake, protocol, eval)."""


# ---------------------------------------------------------------------------
# Minimal RFC6455 client websocket (text frames only, client->server masked)
# ---------------------------------------------------------------------------
class _WS:
    """Hand-rolled minimal websocket client. Enough for CDP: client sends masked
    text frames, server sends unmasked text frames; we also answer ping/close."""

    _GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # informational; server-side use

    def __init__(self, ws_url, timeout=30.0):
        u = urllib.parse.urlparse(ws_url)
        if u.scheme not in ("ws", "wss"):
            raise CDPError(f"unsupported ws scheme: {u.scheme!r}")
        if u.scheme == "wss":
            # CDP on localhost is always ws://; we don't need TLS here.
            raise CDPError("wss not supported by this minimal client")
        self.host = u.hostname
        self.port = u.port or 80
        self.path = u.path + (("?" + u.query) if u.query else "")
        self.timeout = timeout
        self._recv_buf = b""
        self.sock = None
        self._connect()

    def _connect(self):
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise CDPError(f"cannot connect to {self.host}:{self.port}: {e}") from e
        self.sock.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        self.sock.sendall(req.encode())
        # read response headers up to blank line
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CDPError("ws handshake: connection closed during upgrade")
            resp += chunk
        head, _, rest = resp.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if "101" not in status_line:
            raise CDPError(f"ws handshake failed: {status_line!r}")
        self._recv_buf = rest  # any frame bytes that arrived with the handshake

    # ----- framing -----
    def send_text(self, text):
        payload = text.encode("utf-8")
        header = bytearray()
        header.append(0x81)  # FIN + text opcode
        mask_bit = 0x80
        n = len(payload)
        if n < 126:
            header.append(mask_bit | n)
        elif n < 65536:
            header.append(mask_bit | 126)
            header += struct.pack(">H", n)
        else:
            header.append(mask_bit | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        try:
            self.sock.sendall(bytes(header) + masked)
        except OSError as e:
            raise CDPError(f"ws send failed: {e}") from e

    def _recv_exact(self, n):
        while len(self._recv_buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout as e:
                raise CDPError("ws recv timeout") from e
            except OSError as e:
                raise CDPError(f"ws recv failed: {e}") from e
            if not chunk:
                raise CDPError("ws closed by server")
            self._recv_buf += chunk
        out, self._recv_buf = self._recv_buf[:n], self._recv_buf[n:]
        return out

    def recv_text(self):
        """Return the next complete text message (handles fragmentation, control
        frames). Ignores/answers ping & close; skips binary frames."""
        buf = []
        while True:
            b0, b1 = self._recv_exact(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", self._recv_exact(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._recv_exact(8))
            mask = self._recv_exact(4) if masked else b""
            data = self._recv_exact(length) if length else b""
            if masked and data:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:  # close
                raise CDPError("ws server sent close frame")
            if opcode == 0x9:  # ping -> pong
                self._send_control(0xA, data)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x0):  # text or continuation
                buf.append(data)
                if fin:
                    return b"".join(buf).decode("utf-8", "replace")
                continue
            # binary or unknown -> ignore frame, keep reading
            if fin and opcode == 0x2:
                continue

    def _send_control(self, opcode, payload=b""):
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(payload)
        header.append(0x80 | n)  # control frames are always < 126 bytes here
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        try:
            self.sock.sendall(bytes(header) + masked)
        except OSError:
            pass

    def close(self):
        if self.sock is not None:
            try:
                self._send_control(0x8, b"")
            except Exception:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


# ---------------------------------------------------------------------------
# CDP session over the browser-level websocket
# ---------------------------------------------------------------------------
class CDPSession:
    """One browser-level WS connection. Creates a single child tab, attaches with
    a flattened sessionId, and routes Runtime/Page calls to that session.

    Lifecycle: open() (or use as context manager) -> evaluate(...) -> close().
    close() closes ONLY the tab this session created; the WS itself is closed too.
    Pre-existing tabs are never touched.
    """

    def __init__(self, devtools_url=DEFAULT_DEVTOOLS, timeout=30.0):
        self.devtools_url = devtools_url.rstrip("/")
        self.timeout = timeout
        self._ws = None
        self._id = 0
        self.target_id = None
        self.session_id = None
        self._opened = False

    # ----- connection / target lifecycle -----
    def _browser_ws_url(self):
        try:
            req = urllib.request.Request(self.devtools_url + "/json/version")
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                info = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
            raise CDPError(
                f"DevTools endpoint {self.devtools_url} unreachable: {e}. "
                f"Is Chromium running with --remote-debugging-port=9222? "
                f"Fall back to --fixtures.") from e
        ws = info.get("webSocketDebuggerUrl")
        if not ws:
            raise CDPError(f"no webSocketDebuggerUrl in /json/version: {info}")
        return ws

    def open(self, url=DEFAULT_BLANK_HR_URL):
        """Connect, create our own tab at `url`, attach to it (flattened)."""
        if self._opened:
            return self
        ws_url = self._browser_ws_url()
        self._ws = _WS(ws_url, timeout=self.timeout)
        # Create our own tab. background:true so it does NOT steal focus from the
        # user's foreground tab (non-disruptive). newWindow:false keeps it tidy.
        created = self._call(
            "Target.createTarget",
            {"url": url, "background": True},
            timeout=self.timeout,
        )
        self.target_id = created.get("targetId")
        if not self.target_id:
            raise CDPError(f"Target.createTarget returned no targetId: {created}")
        attached = self._call(
            "Target.attachToTarget",
            {"targetId": self.target_id, "flatten": True},
            timeout=self.timeout,
        )
        self.session_id = attached.get("sessionId")
        if not self.session_id:
            raise CDPError(f"Target.attachToTarget returned no sessionId: {attached}")
        self._opened = True
        # Enable Page + Runtime within the tab session (idempotent; ignore result).
        self._call("Page.enable", {}, session=self.session_id, timeout=self.timeout)
        self._call("Runtime.enable", {}, session=self.session_id, timeout=self.timeout)
        return self

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        """Close ONLY our created tab, then the WS. Never touches other tabs."""
        try:
            if self._ws is not None and self.target_id:
                try:
                    self._call("Target.closeTarget", {"targetId": self.target_id},
                               timeout=self.timeout)
                except CDPError:
                    pass
        finally:
            if self._ws is not None:
                self._ws.close()
            self._ws = None
            self._opened = False
            self.target_id = None
            self.session_id = None

    # ----- request/response plumbing (id-correlated) -----
    def _call(self, method, params=None, session=None, timeout=None):
        if self._ws is None:
            raise CDPError("CDP session is not open")
        timeout = timeout or self.timeout
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self._ws.send_text(json.dumps(msg))
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError(f"timeout waiting for response to {method} (id={mid})")
            # Track THIS call's deadline (not self.timeout): a single long
            # Runtime.evaluate (e.g. the 429-throttled code fetch, ~40s+) must be
            # allowed to run for the call's full `timeout` budget, so the socket
            # read window follows `remaining`, not the connect-level default.
            self._ws.sock.settimeout(max(0.1, remaining))
            raw = self._ws.recv_text()
            try:
                resp = json.loads(raw)
            except ValueError:
                continue
            # match by id; ignore events and responses to other ids
            if resp.get("id") != mid:
                continue
            if "error" in resp:
                raise CDPError(f"{method} error: {resp['error']}")
            return resp.get("result", {})

    # ----- the one operation callers need -----
    def wait_for_load(self, timeout=20.0, expect_origin=None):
        """Wait until the tab has actually navigated to the real page and the DOM
        is usable. A freshly created tab reports about:blank with readyState
        'complete' for ~1-2s before the real navigation lands, so we must wait for
        the REAL origin — not just any 'complete' — or a credentialed same-origin
        fetch would run against about:blank (origin 'null') and fail.

        Returns the final {href, origin, ready} dict. Polls via Runtime.evaluate
        rather than racing Page.loadEventFired so a timeout here is non-fatal.
        """
        deadline = time.time() + timeout
        last = {}
        while time.time() < deadline:
            try:
                res = self._call(
                    "Runtime.evaluate",
                    {"expression": "({href:location.href,origin:location.origin,"
                                   "ready:document.readyState})",
                     "returnByValue": True},
                    session=self.session_id, timeout=min(5.0, self.timeout),
                )
                last = (res.get("result") or {}).get("value") or {}
                href = last.get("href") or ""
                origin = last.get("origin") or ""
                ready = last.get("ready")
                landed = href and href != "about:blank" and origin not in ("", "null")
                if expect_origin is not None:
                    landed = landed and origin == expect_origin
                if landed and ready in ("interactive", "complete"):
                    return last
            except CDPError:
                pass
            time.sleep(0.3)
        return last

    def evaluate(self, expression, await_promise=True, timeout=60.0):
        """Run a JS expression in our tab and return the parsed JS value.

        `expression` should be a same-origin async fetch closure invoked inline,
        e.g. `(async () => { ... })()` OR a bare `async () => {...}` (we wrap a
        bare arrow so it is actually invoked). returnByValue serializes the JS
        result to JSON; await_promise resolves the returned promise.
        """
        expr = expression.strip()
        # If the caller passed a bare arrow function literal (not already invoked),
        # wrap-and-invoke it so Runtime.evaluate awaits the returned promise.
        bare_arrow = (
            expr.startswith("async (") or expr.startswith("async(")
            or expr.startswith("async ()") or expr.startswith("() =>")
            or expr.startswith("()=>")
        )
        if bare_arrow and not expr.endswith(")()"):
            expr = f"({expr})()"
        res = self._call(
            "Runtime.evaluate",
            {
                "expression": expr,
                "awaitPromise": bool(await_promise),
                "returnByValue": True,
                "userGesture": False,
            },
            session=self.session_id,
            timeout=timeout,
        )
        details = res.get("exceptionDetails")
        if details:
            text = details.get("text") or ""
            exc = details.get("exception") or {}
            desc = exc.get("description") or exc.get("value") or ""
            raise CDPError(f"JS exception in evaluate: {text} {desc}".strip())
        result = res.get("result", {})
        if result.get("type") == "undefined":
            return None
        if "value" in result:
            return result["value"]
        # returnByValue couldn't serialize (e.g. cyclic) — surface what we can
        raise CDPError(f"evaluate returned non-serializable result: {result}")


# ---------------------------------------------------------------------------
# Convenience one-shot helper
# ---------------------------------------------------------------------------
def run_fetch(expression, url=DEFAULT_BLANK_HR_URL, devtools_url=DEFAULT_DEVTOOLS,
              load_timeout=20.0, eval_timeout=90.0, connect_timeout=30.0):
    """Open our own tab at `url`, wait for load, run `expression`, return the
    parsed JSON, and ALWAYS close our tab. Raises CDPError on any failure so the
    caller can fall back to fixtures.

    This is the single entry point acquire.LiveAcquirer uses each cycle.
    """
    parsed = urllib.parse.urlparse(url)
    expect_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else None
    sess = CDPSession(devtools_url=devtools_url, timeout=connect_timeout)
    try:
        sess.open(url=url)
        landed = sess.wait_for_load(timeout=load_timeout, expect_origin=expect_origin)
        if expect_origin and (landed.get("origin") != expect_origin):
            raise CDPError(
                f"tab never reached {expect_origin} within {load_timeout}s "
                f"(stuck at {landed.get('href')!r}); cannot run a same-origin "
                f"credentialed fetch. Check the HR session / network.")
        return sess.evaluate(expression, await_promise=True, timeout=eval_timeout)
    finally:
        sess.close()


def is_devtools_up(devtools_url=DEFAULT_DEVTOOLS, timeout=4.0):
    """Cheap reachability probe (no tab created). True iff /json/version answers."""
    try:
        req = urllib.request.Request(devtools_url.rstrip("/") + "/json/version")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            json.loads(r.read().decode("utf-8"))
        return True
    except Exception:
        return False


if __name__ == "__main__":
    # Tiny self-test / manual probe (non-disruptive): does a read-only same-origin
    # fetch of the current user via /rest/contests? No — just confirms a trivial
    # same-origin eval works and our tab is opened+closed cleanly.
    import sys
    if not is_devtools_up():
        print("devtools :9222 is DOWN — fixtures-only mode", file=sys.stderr)
        raise SystemExit(2)
    out = run_fetch(
        "async () => ({ ok: true, origin: location.origin, ready: document.readyState })",
        url=DEFAULT_BLANK_HR_URL,
    )
    print(json.dumps(out, indent=1))

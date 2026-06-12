// backend/src/evaluationReplay.mjs
//
// Pure, dependency-free editor-event replay. Reconstructs per-problem content
// states from the flat editor-event stream, classifies inserts as typed vs
// pasted, detects foreign pastes, glitches, bursts, cadence inputs, active
// time, and submit snapshots. Consumed by evaluationMetrics.mjs.
//
// Contract: /tmp/eval-contract.md §evaluationReplay. Monaco content-change
// semantics: a change replaces the range [start,end) of the PRE-change document
// with `text`. Lines/cols are 1-based.
//
// Performance: a session can carry ~200k events over ~2MB of content. Naive
// `content.slice() + text + content.slice()` on every change is O(events ×
// content) and blows past a second. We hold content in a TextBuffer (a piece
// list keyed by a line-start index) that splices locally and materializes the
// full string lazily, only when a foreign-check / snapshot / final read needs
// it.

export const REPLAY = {
  PASTE_PAIR_WINDOW_MS: 500,
  MIN_FOREIGN_PASTE_LEN: 30,
  LARGE_INSERT_PASTE_LEN: 40,
  AUTOCOMPLETE_MAX_LEN: 60,
  BURST_WINDOW_MS: 2000,
  BURST_MIN_CHARS: 80,
  IDLE_GAP_MS: 60000,
  MISMATCH_THRESHOLD: 0.15,
};

// 1-based (line, col) → absolute offset into `content`, clamped to valid range.
export function lineColToOffset(content, line, col) {
  const len = content.length;
  const ln = Math.max(1, line | 0);
  const cl = Math.max(1, col | 0);
  let offset = 0;
  let curLine = 1;
  while (curLine < ln) {
    const nl = content.indexOf("\n", offset);
    if (nl === -1) return len;
    offset = nl + 1;
    curLine++;
  }
  const nl = content.indexOf("\n", offset);
  const lineEnd = nl === -1 ? len : nl;
  let pos = offset + (cl - 1);
  if (pos > lineEnd) pos = lineEnd;
  if (pos > len) pos = len;
  if (pos < 0) pos = 0;
  return pos;
}

// Apply a Monaco content-change to a plain string `content` (used in tests and
// the glitch check). Returns { content, glitch, startOff, endOff, removed }.
export function applyChange(content, detail) {
  const text = typeof detail.text === "string" ? detail.text : "";
  const deletedLen = detail.deletedLen | 0;
  const startOff = lineColToOffset(content, detail.startLine, detail.startCol);
  let endOff = lineColToOffset(content, detail.endLine, detail.endCol);
  if (endOff < startOff) endOff = startOff;
  const rangeLen = endOff - startOff;
  let glitch = false;
  if (rangeLen !== deletedLen) {
    glitch = true;
    endOff = Math.min(content.length, startOff + deletedLen);
  }
  const removed = content.slice(startOff, endOff);
  const next = content.slice(0, startOff) + text + content.slice(endOff);
  return { content: next, glitch, startOff, endOff, removed };
}

// A gap-buffer over a char array. The document lives in `buf` with a movable
// gap [gapStart, gapEnd); logical content is buf[0..gapStart) ++ buf[gapEnd..).
// Locating a 1-based (line,col) edit needs an offset, which we get by walking a
// lazily-maintained line-start index; moving the gap to the edit copies only the
// chars between the old and new gap (cheap for clustered/sequential edits — the
// realistic editing pattern). Insert/delete at the gap are O(text). This keeps
// ~200k local edits over ~2MB content well under a second even for a single
// huge line (the line-array worst case). The full string materializes lazily.
class TextBuffer {
  constructor() {
    this._buf = []; // char array (length = content length + gap size)
    this._gapStart = 0;
    this._gapEnd = 0;
    this._len = 0;
    this._str = "";
    this._strValid = true; // _str matches content?
  }
  get length() {
    return this._len;
  }
  _moveGapTo(pos) {
    // Move the gap so that gapStart === pos.
    const { _buf, _gapStart, _gapEnd } = this;
    if (pos === _gapStart) return;
    if (pos < _gapStart) {
      // shift chars [pos, gapStart) up to the end of the gap
      const count = _gapStart - pos;
      for (let i = 0; i < count; i++) _buf[_gapEnd - 1 - i] = _buf[_gapStart - 1 - i];
      this._gapStart = pos;
      this._gapEnd = _gapEnd - count;
    } else {
      // pos > gapStart: shift chars [gapEnd, gapEnd + (pos - gapStart)) down
      const count = pos - _gapStart;
      for (let i = 0; i < count; i++) _buf[_gapStart + i] = _buf[_gapEnd + i];
      this._gapStart = pos;
      this._gapEnd = _gapEnd + count;
    }
  }
  _ensureGap(n) {
    const gap = this._gapEnd - this._gapStart;
    if (gap >= n) return;
    // Grow: insert extra slots at gapEnd.
    const grow = Math.max(n - gap, 1024, this._len >> 2);
    const filler = new Array(grow);
    // splice is one O(len) move but happens rarely (amortized).
    this._buf.splice(this._gapEnd, 0, ...filler);
    this._gapEnd += grow;
  }
  // Char at logical offset i (no gap move).
  _charAt(i) {
    return i < this._gapStart ? this._buf[i] : this._buf[i + (this._gapEnd - this._gapStart)];
  }
  // 1-based (line,col) → clamped logical offset, computed by scanning the gap
  // buffer directly (no full-string materialization). Counts newlines to reach
  // the target line, then adds the clamped column.
  _offsetForLineCol(line, col) {
    const len = this._len;
    const ln = Math.max(1, line | 0);
    const cl = Math.max(1, col | 0);
    let offset = 0; // start of current line
    let curLine = 1;
    while (curLine < ln) {
      const nl = this._indexOfNewline(offset);
      if (nl === -1) return len;
      offset = nl + 1;
      curLine++;
    }
    let pos = offset + (cl - 1);
    if (pos > len) pos = len;
    if (pos < 0) pos = 0;
    // Clamp col to the line end: scan only the span [offset, pos) for a newline
    // (bounded by the requested column, not the whole line) — this keeps a long
    // single-line document from costing O(line) per edit.
    const nl = this._indexOfNewline(offset, pos);
    if (nl !== -1 && nl < pos) pos = nl;
    return pos;
  }
  // First "\n" at logical offset in [from, to), or -1.
  _indexOfNewline(from, to = this._len) {
    const end = to < this._len ? to : this._len;
    for (let i = from; i < end; i++) {
      if (this._charAt(i) === "\n") return i;
    }
    return -1;
  }
  toString() {
    if (this._strValid) return this._str;
    const { _buf, _gapStart, _gapEnd } = this;
    // Join the two halves.
    let out = "";
    if (_gapStart > 0) out += _buf.slice(0, _gapStart).join("");
    if (_gapEnd < _buf.length) out += _buf.slice(_gapEnd).join("");
    this._str = out;
    this._strValid = true;
    return out;
  }
  apply(detail) {
    const text = typeof detail.text === "string" ? detail.text : "";
    const deletedLen = detail.deletedLen | 0;
    const startOff = this._offsetForLineCol(detail.startLine, detail.startCol);
    let endOff = this._offsetForLineCol(detail.endLine, detail.endCol);
    if (endOff < startOff) endOff = startOff;
    let glitch = false;
    if (endOff - startOff !== deletedLen) {
      glitch = true;
      endOff = Math.min(this._len, startOff + deletedLen);
    }
    const delCount = endOff - startOff;
    // Capture removed chars before mutating.
    let removed = "";
    if (delCount > 0) {
      const parts = new Array(delCount);
      for (let i = 0; i < delCount; i++) parts[i] = this._charAt(startOff + i);
      removed = parts.join("");
    }
    // Move gap to startOff, delete by extending gapEnd, then insert text.
    this._moveGapTo(startOff);
    this._gapEnd += delCount; // swallow deleted chars into the gap
    this._ensureGap(text.length);
    for (let i = 0; i < text.length; i++) this._buf[this._gapStart++] = text[i];
    this._len += text.length - delCount;
    this._strValid = false;
    return { glitch, removed };
  }
}

// Whitespace-collapse + trim. Shared normalizer for substring/foreign matching.
export function collapseWs(s) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

// Line-token Levenshtein normalized by max line count → 0..1.
export function normalizedLineDistance(a, b) {
  const la = String(a == null ? "" : a).split("\n");
  const lb = String(b == null ? "" : b).split("\n");
  const A = trimTrailingEmpty(la);
  const B = trimTrailingEmpty(lb);
  if (A.length === 0 && B.length === 0) return 0;
  const dist = lineLevenshtein(A, B);
  return dist / Math.max(1, Math.max(A.length, B.length));
}

function trimTrailingEmpty(lines) {
  const out = lines.slice();
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

function lineLevenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

const AUTOCOMPLETE_END = /[A-Za-z0-9_$)\]}>"';:,.]$/;
function isAutocompleteShaped(text) {
  if (text.includes("\n")) return false;
  if (text.length > REPLAY.AUTOCOMPLETE_MAX_LEN) return false;
  return AUTOCOMPLETE_END.test(text);
}

function lenWithinPair(insertedLen, pasteLen) {
  const tol = Math.max(20, Math.floor(0.1 * pasteLen));
  return Math.abs(insertedLen - pasteLen) <= tol;
}

// replaySession — single pass over the time-sorted event stream.
//
// Classification uses a small "recent changes" / "pending pastes" window so a
// paste marker can pair with the coincident text-carrying change whether that
// change arrives just before or just after it (±500ms). Accounting is done ONCE
// per change: a change is classified typed OR paste, and the paste-marker `len`
// is never separately added to the totals — the change's true insertedLen is
// the source of truth; an UNPAIRED marker (no text-carrying change) contributes
// its `len` to pasted_chars as a fallback.
export function replaySession(events, { stubs = [], extraSelfTexts = [] } = {}) {
  const collapsedStubs = stubs.map((s) => collapseWs(s)).filter((s) => s.length > 0);
  const collapsedExtraSelf = extraSelfTexts.map((s) => collapseWs(s)).filter((s) => s.length > 0);

  const problems = new Map(); // pid → state
  function probState(pid) {
    let st = problems.get(pid);
    if (!st) {
      st = { buf: new TextBuffer(), glitches: 0, first_ts: null, last_ts: null, collapsedCache: "", collapsedDirty: true };
      problems.set(pid, st);
    }
    return st;
  }

  const selfHistory = []; // collapsed removed-blob strings (≥30 chars removed)
  const pastes = [];
  const bursts = [];
  const typedByProblem = new Map();
  const pastedByProblem = new Map();
  const singleCharTsByProblem = new Map();
  const activeMsByProblem = new Map();
  const runMarks = [];
  const submitMarks = [];
  const submitSnapshots = [];
  const stubReloads = [];

  function addN(map, pid, n) {
    map.set(pid, (map.get(pid) || 0) + n);
  }

  let prevTs = null;
  let prevPid = null;
  let activeProblem = null;

  const lastStubReloadTs = new Map();
  // Pending paste markers awaiting a forward text-carrying change.
  const pendingPastes = []; // { pid, ts, len, record }
  // Recent text-carrying changes awaiting a backward paste marker.
  const recentChanges = []; // { pid, ts, insertedLen, text, truncated, beforeStr, st, consumed, typedCredited, burstCredited }
  // Burst tracking per problem.
  const burstWin = new Map();

  let eventsN = 0;

  for (const ev of events) {
    eventsN++;
    const tsRaw = Date.parse(ev.timestamp);
    const tsMs = Number.isFinite(tsRaw) ? tsRaw : null;
    let pid = ev.problem_id;
    const type = ev.type;
    const detail = ev.detail || {};

    if (type === "problem_switched") {
      const to = detail.to_problem_id;
      if (to != null) activeProblem = to;
      if (pid == null) pid = activeProblem;
      else activeProblem = pid;
    } else if (pid != null) {
      activeProblem = pid;
    } else {
      pid = activeProblem;
    }

    // Active-ms accumulation (gap attributed to the problem active during it).
    if (tsMs != null && prevTs != null && prevPid != null) {
      const gap = tsMs - prevTs;
      if (gap > 0 && gap <= REPLAY.IDLE_GAP_MS) addN(activeMsByProblem, prevPid, gap);
    }
    if (tsMs != null) {
      prevTs = tsMs;
      prevPid = pid;
    }

    if (pid != null && tsMs != null) {
      const st = probState(pid);
      if (st.first_ts == null) st.first_ts = tsMs;
      st.last_ts = tsMs;
    }

    // Evict stale window entries relative to this event's time.
    if (tsMs != null) {
      while (recentChanges.length && tsMs - recentChanges[0].ts > REPLAY.PASTE_PAIR_WINDOW_MS) {
        finalizeChange(recentChanges.shift());
      }
      for (let i = pendingPastes.length - 1; i >= 0; i--) {
        if (tsMs - pendingPastes[i].ts > REPLAY.PASTE_PAIR_WINDOW_MS) pendingPastes.splice(i, 1);
      }
    }

    switch (type) {
      case "stub_reloaded": {
        if (pid != null) {
          stubReloads.push({ problem_id: pid, ts: tsMs });
          if (tsMs != null) lastStubReloadTs.set(pid, tsMs);
        }
        break;
      }
      case "code_run": {
        if (pid != null) runMarks.push({ problem_id: pid, ts: tsMs });
        break;
      }
      case "code_submit": {
        if (pid != null) {
          submitMarks.push({ problem_id: pid, ts: tsMs });
          const st = probState(pid);
          submitSnapshots.push({ problem_id: pid, ts: tsMs, content: st.buf.toString() });
        }
        break;
      }
      case "editor_paste": {
        if (pid == null) break;
        const len = detail.len | 0;
        // Try to pair with a recent (backward) text-carrying change.
        let matched = null;
        for (let i = recentChanges.length - 1; i >= 0; i--) {
          const rc = recentChanges[i];
          if (rc.consumed) continue;
          if (rc.pid !== pid) continue;
          if (lenWithinPair(rc.insertedLen, len)) {
            matched = rc;
            break;
          }
        }
        if (matched) {
          // Reclassify this change from typed → paste (the marker proves a paste).
          matched.consumed = true;
          reclassifyAsPaste(matched, pid);
        } else {
          // No backward match: register a len-only paste record + pending marker.
          const rec = { problem_id: pid, ts: tsMs, len, text: "", preview: "", paired: false, foreign: false, truncated: false };
          pastes.push(rec);
          addN(pastedByProblem, pid, len);
          pendingPastes.push({ pid, ts: tsMs, len, record: rec });
        }
        break;
      }
      case "editor_insert":
      case "editor_replace":
      case "editor_delete": {
        if (pid == null) break;
        const st = probState(pid);
        // Capture the pre-change content ONLY when this change might need a
        // foreign check (large insert or pending paste pairing). Materializing
        // the full buffer on every keystroke would be O(events × content).
        const insertedLenPeek = detail.insertedLen | 0;
        const mightForeign = insertedLenPeek >= REPLAY.MIN_FOREIGN_PASTE_LEN || pendingPastes.length > 0;
        const beforeStr = mightForeign ? st.buf.toString() : "";
        const res = st.buf.apply(detail);
        st.collapsedDirty = true;
        if (res.glitch) st.glitches += 1;

        const insertedLen = detail.insertedLen | 0;
        const removed = res.removed || "";
        if ((type === "editor_delete" || type === "editor_replace") && removed.length >= REPLAY.MIN_FOREIGN_PASTE_LEN) {
          const cr = collapseWs(removed);
          if (cr.length >= REPLAY.MIN_FOREIGN_PASTE_LEN) selfHistory.push(cr);
        }

        const text = typeof detail.text === "string" ? detail.text : "";
        const truncated = detail.truncated === true || detail.text_truncated === true;

        if (insertedLen === 1 && type === "editor_insert" && tsMs != null) {
          let arr = singleCharTsByProblem.get(pid);
          if (!arr) {
            arr = [];
            singleCharTsByProblem.set(pid, arr);
          }
          arr.push(tsMs);
        }

        if (insertedLen <= 0) break;

        // Forward-pair a pending paste marker (text now known).
        let pairedPending = null;
        for (let i = pendingPastes.length - 1; i >= 0; i--) {
          const pp = pendingPastes[i];
          if (pp.pid !== pid) continue;
          if (lenWithinPair(insertedLen, pp.len)) {
            pairedPending = pp;
            pendingPastes.splice(i, 1);
            break;
          }
        }

        const collapsedText = collapseWs(text);
        const isStubMatch =
          collapsedText.length > 0 &&
          collapsedStubs.some((s) => s.length >= collapsedText.length && s.includes(collapsedText));
        const recentStubReload =
          tsMs != null && lastStubReloadTs.has(pid) && tsMs - lastStubReloadTs.get(pid) <= 2000;

        if (pairedPending) {
          // The marker already credited pp.len to pasted; correct it to the true
          // insertedLen and convert the len-only record into a textful one.
          addN(pastedByProblem, pid, insertedLen - pairedPending.len);
          const rec = pairedPending.record;
          rec.text = text;
          rec.preview = collapsedText.slice(0, 200);
          rec.len = insertedLen;
          rec.paired = true;
          rec.truncated = truncated;
          rec.foreign = isForeign(text, beforeStr, st, problems, selfHistory, collapsedStubs, collapsedExtraSelf);
          // No burst/typed credit — it's a paste.
          continue;
        }

        // Not (yet) paired with a marker. Hold the change in the window so a
        // later backward paste marker can reclassify it. Provisionally credit
        // it as typed-or-large-paste; finalizeChange() commits on eviction.
        const change = {
          pid,
          ts: tsMs,
          insertedLen,
          text,
          collapsedText,
          truncated,
          beforeStr,
          st,
          isStubMatch,
          recentStubReload,
          consumed: false,
          finalized: false,
          // provisional classification (large unpaired insert → paste unless excluded)
          provisionalPaste:
            insertedLen >= REPLAY.LARGE_INSERT_PASTE_LEN &&
            !isAutocompleteShaped(text) &&
            !isStubMatch &&
            !recentStubReload,
        };
        if (tsMs == null) {
          // No timestamp → can't window-pair; finalize immediately.
          finalizeChange(change);
        } else {
          recentChanges.push(change);
        }
        break;
      }
      default:
        break;
    }
  }

  // Flush any changes still in the window.
  while (recentChanges.length) finalizeChange(recentChanges.shift());

  // ---- closures capturing the accumulators ----
  function reclassifyAsPaste(change, pid) {
    // change was held provisionally; the marker proves a paste. Credit pasted,
    // do not credit typed/burst.
    change.finalized = true;
    addN(pastedByProblem, pid, change.insertedLen);
    const rec = {
      problem_id: pid,
      ts: change.ts,
      len: change.insertedLen,
      text: change.text,
      preview: change.collapsedText.slice(0, 200),
      paired: true,
      foreign: isForeign(change.text, change.beforeStr, change.st, problems, selfHistory, collapsedStubs, collapsedExtraSelf),
      truncated: change.truncated === true,
    };
    pastes.push(rec);
  }

  function finalizeChange(change) {
    if (!change || change.finalized || change.consumed) return;
    change.finalized = true;
    const pid = change.pid;
    if (change.provisionalPaste) {
      addN(pastedByProblem, pid, change.insertedLen);
      pastes.push({
        problem_id: pid,
        ts: change.ts,
        len: change.insertedLen,
        text: change.text,
        preview: change.collapsedText.slice(0, 200),
        paired: false,
        foreign: isForeign(change.text, change.beforeStr, change.st, problems, selfHistory, collapsedStubs, collapsedExtraSelf),
        truncated: change.truncated === true,
      });
    } else {
      addN(typedByProblem, pid, change.insertedLen);
      if (change.ts != null) addToBurst(burstWin, bursts, pid, change.ts, change.insertedLen);
    }
  }

  const problemsOut = {};
  for (const [pid, st] of problems) {
    problemsOut[pid] = {
      final_content: st.buf.toString(),
      glitches: st.glitches,
      first_ts: st.first_ts,
      last_ts: st.last_ts,
    };
  }

  return {
    problems: problemsOut,
    pastes,
    bursts,
    typed_chars_by_problem: mapToObj(typedByProblem),
    pasted_chars_by_problem: mapToObj(pastedByProblem),
    single_char_ts_by_problem: mapToObj(singleCharTsByProblem),
    active_ms_by_problem: mapToObj(activeMsByProblem),
    run_marks: runMarks,
    submit_marks: submitMarks,
    submit_snapshots: submitSnapshots,
    stub_reloads: stubReloads,
    events_n: eventsN,
  };
}

function mapToObj(map) {
  const o = {};
  for (const [k, v] of map) o[k] = typeof v === "number" && v < 0 ? 0 : v;
  return o;
}

// Foreign iff collapsed text (≥30) is NOT a substring of:
//  - the current problem's pre-change content
//  - any other problem's current content (lazily collapsed + cached)
//  - self-history (removed blobs)
//  - any stub
//  - any extraSelfText
function isForeign(text, beforeContent, curSt, allProblems, selfHistory, collapsedStubs, collapsedExtraSelf) {
  const c = collapseWs(text);
  if (c.length < REPLAY.MIN_FOREIGN_PASTE_LEN) return false;
  if (collapseWs(beforeContent).includes(c)) return false;
  for (const [, st] of allProblems) {
    if (st === curSt) continue;
    if (st.collapsedDirty) {
      st.collapsedCache = collapseWs(st.buf.toString());
      st.collapsedDirty = false;
    }
    if (st.collapsedCache.includes(c)) return false;
  }
  for (const h of selfHistory) if (h.includes(c)) return false;
  for (const s of collapsedStubs) if (s.includes(c)) return false;
  for (const s of collapsedExtraSelf) if (s.includes(c)) return false;
  return true;
}

function addToBurst(burstWin, bursts, pid, ts, chars) {
  let arr = burstWin.get(pid);
  if (!arr) {
    arr = [];
    burstWin.set(pid, arr);
  }
  arr.push({ ts, chars });
  while (arr.length && ts - arr[0].ts > REPLAY.BURST_WINDOW_MS) arr.shift();
  let sum = 0;
  for (const e of arr) sum += e.chars;
  if (sum >= REPLAY.BURST_MIN_CHARS) {
    bursts.push({ problem_id: pid, ts, chars: sum });
    arr.length = 0;
  }
}

import { AlertTriangle, Clock, Film, Pause, Play, RefreshCw, Search, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAdminSessions, fetchRecordingSessions, fetchSubmissionEvents } from "./api";
import type { AdminSessionDetail, RecordingSession, SessionEvidence, SubmissionEvent } from "./types";

// Every recorded chunk is a fixed 30-second .webm (uploadConfig.chunk_seconds on
// the backend). The playback timeline is built around this constant.
const CHUNK_SECONDS = 30;

// A single chunk placed on the test-relative timeline. offsetSec is the chunk's
// START time in seconds relative to the test start; [offsetSec, offsetSec+CHUNK_SECONDS]
// is the span it occupies. `url` is the signed download URL (refreshable).
type TimelineChunk = {
  index: number; // 1-based numeric index parsed from the chunk key
  key: string;
  url: string;
  offsetSec: number; // start, relative to test start
  endSec: number; // offsetSec + CHUNK_SECONDS
};

// A SUBMISSION-TIME MARKER placed on the test-relative timeline: offsetSec is the
// submission's real time relative to the test start, valid drives GREEN/RED.
type TimelineMarker = {
  event: SubmissionEvent;
  offsetSec: number; // (submitted_at − testStart), in seconds
};

// Pull the numeric index out of a screen-chunk key, e.g.
// ".../screen/chunk-00007.webm" → 7. Returns NaN for non-matching keys.
function chunkIndexFromKey(key: string): number {
  const match = key.match(/screen\/chunk-(\d+)\.(?:webm|bin)$/);
  return match ? Number(match[1]) : NaN;
}

function isScreenChunk(evidence: SessionEvidence): boolean {
  return /screen\/chunk-\d+\.(?:webm|bin)$/.test(evidence.key);
}

// Format seconds as mm:ss (or h:mm:ss past an hour). Negative inputs clamp to 0.
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// datetime-local <input> value (local, no tz suffix) ⇄ ISO. Mirrors App.tsx.
function isoToLocalInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localInputToMs(value: string): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

// Build the playlist for one session against a chosen test-start time.
//
// Each chunk is placed on the timeline by REAL time when its last_modified is
// known: a chunk's object is finalized when its 30s window CLOSES, so its START
// offset is (last_modified − CHUNK_SECONDS) relative to the test start. This is
// what correctly handles late-joiners (their first chunk lands after 0) and
// recording GAPS (a missing minute leaves a blank span). When last_modified is
// missing we fall back to index-based contiguous placement anchored on the
// session's created_at, so the playlist is still coherent.
function buildPlaylist(
  evidence: SessionEvidence[],
  sessionCreatedAt: string | undefined,
  testStartMs: number
): TimelineChunk[] {
  const createdMs = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  const chunks = evidence
    .filter(isScreenChunk)
    .map((file) => ({ file, index: chunkIndexFromKey(file.key) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);

  return chunks.map((entry) => {
    const modifiedMs = entry.file.last_modified ? Date.parse(entry.file.last_modified) : NaN;
    let offsetSec: number;
    if (Number.isFinite(modifiedMs) && Number.isFinite(testStartMs)) {
      offsetSec = (modifiedMs - CHUNK_SECONDS * 1000 - testStartMs) / 1000;
    } else {
      // Index-based contiguous fallback, anchored on created_at vs test start.
      const anchorOffset = Number.isFinite(createdMs) && Number.isFinite(testStartMs)
        ? (createdMs - testStartMs) / 1000
        : 0;
      offsetSec = (entry.index - 1) * CHUNK_SECONDS + anchorOffset;
    }
    return {
      index: entry.index,
      key: entry.file.key,
      url: entry.file.download_url,
      offsetSec,
      endSec: offsetSec + CHUNK_SECONDS
    };
  });
}

// Pick the chunk whose [offset, end] span contains testTime; if none contains it
// (a gap), pick the nearest chunk by edge distance so a click in a blank seeks to
// the closest available recording. Returns the playlist position (array index).
function chunkPosForTestTime(playlist: TimelineChunk[], testTime: number): number {
  if (!playlist.length) return -1;
  const containing = playlist.findIndex((c) => testTime >= c.offsetSec && testTime < c.endSec);
  if (containing !== -1) return containing;
  let best = 0;
  let bestDist = Infinity;
  playlist.forEach((c, i) => {
    const dist = testTime < c.offsetSec ? c.offsetSec - testTime : testTime - c.endSec;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

type Props = {
  password: string;
};

export function RecordingReview({ password }: Props) {
  // Picker: the lightweight recording-sessions list (null until loaded; an empty
  // array means "endpoint not deployed" → manual username entry).
  const [recordingSessions, setRecordingSessions] = useState<RecordingSession[] | null>(null);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [endpointAvailable, setEndpointAvailable] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [manualUsername, setManualUsername] = useState("");

  // Selected user's loaded sessions (with signed evidence) + which one is active.
  const [sessions, setSessions] = useState<AdminSessionDetail[]>([]);
  // The selected user's SUBMISSION-TIME MARKERS (poller-sourced). Empty when the
  // user has none or the endpoint is not deployed (graceful — no markers shown).
  const [submissionEvents, setSubmissionEvents] = useState<SubmissionEvent[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [loadingUser, setLoadingUser] = useState(false);
  const [error, setError] = useState("");

  // Test-start anchor (datetime-local string). All timeline labels are relative.
  const [testStartInput, setTestStartInput] = useState("");

  // Player state.
  const [currentPos, setCurrentPos] = useState(0); // playlist index of the loaded chunk
  const [playing, setPlaying] = useState(false);
  const [currentTestTime, setCurrentTestTime] = useState(0); // seconds, test-relative
  const [refreshNote, setRefreshNote] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloadRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // Guards a single in-flight URL refresh so a burst of errors doesn't stampede.
  const refreshingRef = useRef(false);

  // ---- Load the lightweight picker list once. -----------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchRecordingSessions(password);
        if (cancelled) return;
        if (list === null) {
          setEndpointAvailable(false);
          setRecordingSessions([]);
        } else {
          setRecordingSessions(list);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setPickerLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [password]);

  // The active session object + its playlist, recomputed when the selection or
  // the test-start anchor changes.
  const activeSession = useMemo(
    () => sessions.find((s) => String(s.session_id) === selectedSessionId) ?? sessions[0],
    [sessions, selectedSessionId]
  );

  const testStartMs = useMemo(() => localInputToMs(testStartInput), [testStartInput]);

  const playlist = useMemo(() => {
    if (!activeSession) return [];
    return buildPlaylist(activeSession.evidence ?? [], activeSession.created_at, testStartMs);
  }, [activeSession, testStartMs]);

  // Timeline span: from the first chunk's start to the last chunk's end. Clamped
  // so a single-chunk or all-gap session still yields a usable bar.
  const span = useMemo(() => {
    if (!playlist.length) return { start: 0, end: CHUNK_SECONDS };
    const start = Math.min(0, ...playlist.map((c) => c.offsetSec));
    const end = Math.max(...playlist.map((c) => c.endSec));
    return { start, end: Math.max(end, start + CHUNK_SECONDS) };
  }, [playlist]);
  const spanDuration = Math.max(1, span.end - span.start);

  // SUBMISSION-TIME MARKERS, placed on the SAME test-relative scale the timeline
  // uses: offsetSec = (submitted_at − testStart). Recomputed whenever the events
  // OR the test-start anchor change, so markers stay aligned when the test-start
  // input is edited. Sorted ascending so overlapping markers paint deterministically.
  const markers = useMemo<TimelineMarker[]>(() => {
    if (!submissionEvents.length || !Number.isFinite(testStartMs)) return [];
    return submissionEvents
      .map((event) => {
        const submittedMs = Date.parse(event.submitted_at);
        if (!Number.isFinite(submittedMs)) return null;
        return { event, offsetSec: (submittedMs - testStartMs) / 1000 };
      })
      .filter((marker): marker is TimelineMarker => marker !== null)
      .sort((a, b) => a.offsetSec - b.offsetSec);
  }, [submissionEvents, testStartMs]);

  const validCount = useMemo(() => markers.filter((m) => m.event.valid).length, [markers]);
  const invalidCount = markers.length - validCount;

  // ---- Load a chosen user's sessions (with signed evidence). --------------
  const loadUser = useCallback(
    async (username: string) => {
      const trimmed = username.trim();
      if (!trimmed) return;
      setLoadingUser(true);
      setError("");
      setRefreshNote("");
      try {
        const response = await fetchAdminSessions(trimmed, password);
        const loaded = response.sessions ?? [];
        setSessions(loaded);
        // Default to the newest session (sessions arrive newest-first from the
        // backend; pick the max created_at defensively).
        const newest = [...loaded].sort((a, b) =>
          String(b.created_at || "").localeCompare(String(a.created_at || ""))
        )[0];
        setSelectedSessionId(newest ? String(newest.session_id) : "");
        setTestStartInput(isoToLocalInput(newest?.created_at));
        setCurrentPos(0);
        setCurrentTestTime(0);
        setPlaying(false);
        if (!loaded.length) setError(`No sessions found for "${trimmed}".`);

        // Also fetch the student's SUBMISSION-TIME MARKERS. Scope to the newest
        // session's contest so the markers line up with that test; a 404 (or
        // null) just means no markers — never blocks the recording view.
        try {
          const events = await fetchSubmissionEvents(password, trimmed, newest?.contest_slug || undefined);
          setSubmissionEvents(events ?? []);
        } catch {
          setSubmissionEvents([]);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setSessions([]);
        setSubmissionEvents([]);
      } finally {
        setLoadingUser(false);
      }
    },
    [password]
  );

  // When the active session changes (different session picked), reset the anchor
  // to that session's created_at and rewind playback.
  const selectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      const next = sessions.find((s) => String(s.session_id) === sessionId);
      setTestStartInput(isoToLocalInput(next?.created_at));
      setCurrentPos(0);
      setCurrentTestTime(0);
      setPlaying(false);
    },
    [sessions]
  );

  // Refresh the signed evidence URLs (they expire ~1h) by re-calling
  // fetchAdminSessions, preserving the current selection/position. Returns the
  // fresh URL for the chunk at `posToKeep` so the caller can resume in place.
  const refreshUrls = useCallback(async (): Promise<string | null> => {
    if (refreshingRef.current || !activeSession) return null;
    const username = activeSession.hackerrank_username;
    if (!username) return null;
    refreshingRef.current = true;
    try {
      const response = await fetchAdminSessions(String(username), password);
      const fresh = response.sessions ?? [];
      setSessions(fresh);
      setRefreshNote("Recording links refreshed.");
      const refreshed = fresh.find((s) => String(s.session_id) === selectedSessionId) ?? fresh[0];
      const list = buildPlaylist(refreshed?.evidence ?? [], refreshed?.created_at, testStartMs);
      return list[currentPos]?.url ?? null;
    } catch {
      return null;
    } finally {
      refreshingRef.current = false;
    }
  }, [activeSession, password, selectedSessionId, currentPos, testStartMs]);

  // ---- Load the current chunk into the <video> and (optionally) play. -----
  // We set src imperatively (not via JSX) so we can also drive seek + play/pause
  // and warm the preload element without React re-render churn.
  const loadChunkIntoPlayer = useCallback(
    (pos: number, seekWithinSec: number, autoplay: boolean) => {
      const video = videoRef.current;
      const chunk = playlist[pos];
      if (!video || !chunk) return;
      if (video.dataset.chunkKey !== chunk.key) {
        video.dataset.chunkKey = chunk.key;
        video.src = chunk.url;
        video.load();
      }
      const applySeek = () => {
        const target = Math.max(0, Math.min(seekWithinSec, CHUNK_SECONDS));
        if (Number.isFinite(target)) {
          try {
            video.currentTime = target;
          } catch {
            // currentTime can throw before metadata; the loadedmetadata retry covers it.
          }
        }
        if (autoplay) void video.play().catch(() => undefined);
      };
      if (video.readyState >= 1) applySeek();
      else video.addEventListener("loadedmetadata", applySeek, { once: true });
    },
    [playlist]
  );

  // Warm the NEXT chunk in a hidden <video> so auto-advance has minimal gap.
  useEffect(() => {
    const next = playlist[currentPos + 1];
    const preload = preloadRef.current;
    if (!preload || !next) return;
    if (preload.dataset.chunkKey !== next.key) {
      preload.dataset.chunkKey = next.key;
      preload.src = next.url;
      preload.load();
    }
  }, [playlist, currentPos]);

  // Seek to an absolute test-time: find the containing/nearest chunk, load it,
  // and seek to (testTime − chunkOffset) within that chunk.
  const seekToTestTime = useCallback(
    (testTime: number, autoplay: boolean) => {
      const pos = chunkPosForTestTime(playlist, testTime);
      if (pos === -1) return;
      const chunk = playlist[pos];
      const withinChunk = Math.max(0, Math.min(testTime - chunk.offsetSec, CHUNK_SECONDS));
      setCurrentPos(pos);
      setCurrentTestTime(testTime);
      loadChunkIntoPlayer(pos, withinChunk, autoplay);
    },
    [playlist, loadChunkIntoPlayer]
  );

  // When the playlist first becomes available (or changes session), load the
  // current chunk so the player shows a frame and the timeline is live. The
  // chunkKey guard avoids reloading when only the URL was refreshed in place
  // (the error handler already resumed that case).
  useEffect(() => {
    if (!playlist.length) return;
    const pos = Math.min(currentPos, playlist.length - 1);
    const chunk = playlist[pos];
    const video = videoRef.current;
    if (!video || !chunk) return;
    if (video.dataset.chunkKey === chunk.key) return;
    const withinChunk = Math.max(0, currentTestTime - chunk.offsetSec);
    loadChunkIntoPlayer(pos, withinChunk, playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist]);

  // ---- <video> event wiring (timeupdate, ended→advance, error→refresh). ---
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    const chunk = playlist[currentPos];
    if (!video || !chunk) return;
    setCurrentTestTime(chunk.offsetSec + video.currentTime);
  }, [playlist, currentPos]);

  const handleEnded = useCallback(() => {
    // AUTO-ADVANCE by index order; keep playing. The preloaded next chunk makes
    // the handoff near-seamless.
    const nextPos = currentPos + 1;
    if (nextPos < playlist.length) {
      const next = playlist[nextPos];
      setCurrentPos(nextPos);
      setCurrentTestTime(next.offsetSec);
      loadChunkIntoPlayer(nextPos, 0, true);
    } else {
      setPlaying(false);
    }
  }, [currentPos, playlist, loadChunkIntoPlayer]);

  const handleError = useCallback(() => {
    // A signed URL may have expired (~1h → 403) or the media failed to load.
    // Transparently re-sign and resume at the same chunk/position.
    void (async () => {
      const video = videoRef.current;
      const chunk = playlist[currentPos];
      const resumeWithin = video && chunk ? Math.max(0, currentTestTime - chunk.offsetSec) : 0;
      const freshUrl = await refreshUrls();
      if (freshUrl && video) {
        video.dataset.chunkKey = "";
        loadChunkIntoPlayer(currentPos, resumeWithin, playing);
      }
    })();
  }, [playlist, currentPos, currentTestTime, refreshUrls, loadChunkIntoPlayer, playing]);

  const handlePlay = useCallback(() => setPlaying(true), []);
  const handlePause = useCallback(() => setPlaying(false), []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (!video.src && playlist[currentPos]) loadChunkIntoPlayer(currentPos, 0, true);
      else void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [playlist, currentPos, loadChunkIntoPlayer]);

  // Click on the scrubber bar → seek to that test-time.
  const handleBarClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bar = barRef.current;
      if (!bar || !playlist.length) return;
      const rect = bar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const testTime = span.start + fraction * spanDuration;
      seekToTestTime(testTime, playing || !videoRef.current?.paused);
    },
    [playlist, span.start, spanDuration, seekToTestTime, playing]
  );

  // Minute tick marks across the span (mm:ss labels, relative to test start).
  const ticks = useMemo(() => {
    const out: Array<{ sec: number; pct: number }> = [];
    const firstTick = Math.ceil(span.start / 60) * 60;
    for (let sec = firstTick; sec <= span.end; sec += 60) {
      out.push({ sec, pct: ((sec - span.start) / spanDuration) * 100 });
    }
    return out;
  }, [span.start, span.end, spanDuration]);

  const playheadPct = Math.max(0, Math.min(100, ((currentTestTime - span.start) / spanDuration) * 100));

  // Filtered picker list (search box). Case-insensitive over username + name + room.
  const filteredSessions = useMemo(() => {
    if (!recordingSessions) return [];
    const q = searchText.trim().toLowerCase();
    if (!q) return recordingSessions.slice(0, 100);
    return recordingSessions
      .filter((s) =>
        `${s.hackerrank_username} ${s.name} ${s.room}`.toLowerCase().includes(q)
      )
      .slice(0, 100);
  }, [recordingSessions, searchText]);

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex items-center gap-3">
          <Film size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Recordings</h1>
            <p className="mt-1 text-sm text-muted">
              Pick a student and watch their screen recording on a test-relative timeline. Playback advances seamlessly across 30-second chunks.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* LEFT: username picker (search list, or manual entry when no endpoint). */}
        <aside className="space-y-3 rounded-lg border border-line bg-panel p-4 shadow-subtle">
          {endpointAvailable ? (
            <>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Find a student</span>
                <div className="relative mt-1">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    className="focus-ring h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm"
                    placeholder="Search username, name, or room"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                  />
                </div>
              </label>
              <div className="max-h-[28rem] space-y-1.5 overflow-auto">
                {!pickerLoaded ? (
                  <p className="px-1 py-2 text-xs text-muted">Loading recordings…</p>
                ) : filteredSessions.length ? (
                  filteredSessions.map((s) => (
                    <button
                      key={s.session_id}
                      type="button"
                      onClick={() => void loadUser(s.hackerrank_username)}
                      className="focus-ring block w-full rounded-md border border-line bg-white/60 px-3 py-2 text-left hover:border-ink/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{s.hackerrank_username}</span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
                          <Video size={10} /> {s.chunk_count}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                        {s.name ? <span className="truncate">{s.name}</span> : null}
                        {s.room ? <span>· {s.room}</span> : null}
                      </div>
                      {s.created_at ? (
                        <div className="mt-0.5 text-[11px] text-muted">{new Date(s.created_at).toLocaleString()}</div>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <p className="px-1 py-2 text-xs text-muted">No matching recordings.</p>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                The recordings index endpoint is not deployed yet. Enter a HackerRank username to load that student's recording directly.
              </p>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">HackerRank username</span>
                <input
                  className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                  value={manualUsername}
                  onChange={(event) => setManualUsername(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void loadUser(manualUsername);
                  }}
                />
              </label>
              <button
                type="button"
                className="focus-ring inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void loadUser(manualUsername)}
                disabled={loadingUser || !manualUsername.trim()}
              >
                <Search size={16} /> Load recording
              </button>
            </>
          )}
        </aside>

        {/* RIGHT: session controls + timeline + player. */}
        <div className="space-y-4">
          {error ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
          ) : null}

          {loadingUser ? (
            <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-muted">
              <RefreshCw size={18} className="mx-auto animate-spin text-accent" />
              <p className="mt-2">Loading sessions…</p>
            </div>
          ) : !activeSession ? (
            <div className="rounded-lg border border-line bg-panel p-8 text-center text-sm text-muted">
              <Film size={22} className="mx-auto text-muted" />
              <p className="mt-3">Select a student to load their screen recording.</p>
            </div>
          ) : (
            <>
              {/* Session selector + test-start anchor. */}
              <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
                <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
                  <label className="block">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">Session</span>
                    <select
                      className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                      value={selectedSessionId}
                      onChange={(event) => selectSession(event.target.value)}
                    >
                      {sessions.map((s) => (
                        <option key={String(s.session_id)} value={String(s.session_id)}>
                          {s.created_at ? new Date(s.created_at).toLocaleString() : String(s.session_id)} · {String(s.status ?? "")} · {(s.evidence ?? []).filter((e) => isScreenChunk(e)).length} chunks
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">Test start time</span>
                    <input
                      type="datetime-local"
                      className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                      value={testStartInput}
                      onChange={(event) => setTestStartInput(event.target.value)}
                    />
                  </label>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {activeSession.name ? `${activeSession.name} · ` : ""}
                  {activeSession.hackerrank_username}
                  {activeSession.room ? ` · Room ${activeSession.room}` : ""}
                  {" · "}timeline labels are mm:ss relative to the test start above.
                </p>
              </div>

              {/* PLAYER */}
              <div className="overflow-hidden rounded-lg border border-line bg-ink">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  ref={videoRef}
                  className="aspect-video w-full bg-black object-contain"
                  playsInline
                  controls={false}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={handleEnded}
                  onError={handleError}
                  onPlay={handlePlay}
                  onPause={handlePause}
                />
                {/* Hidden warm-up element for the NEXT chunk (seamless advance). */}
                <video ref={preloadRef} className="hidden" preload="auto" muted playsInline />
              </div>

              {/* CONTROLS + readout */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-3 shadow-subtle">
                <button
                  type="button"
                  onClick={togglePlay}
                  disabled={!playlist.length}
                  className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />} {playing ? "Pause" : "Play"}
                </button>
                <span className="inline-flex items-center gap-1.5 font-mono text-sm text-ink">
                  <Clock size={14} className="text-muted" />
                  {formatClock(currentTestTime)} <span className="text-muted">/ {formatClock(span.end)}</span>
                </span>
                <span className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                  chunk {playlist.length ? currentPos + 1 : 0} / {playlist.length}
                </span>
                {refreshNote ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs text-accent">
                    <RefreshCw size={12} /> {refreshNote}
                  </span>
                ) : null}
              </div>

              {/* TIMELINE scrubber */}
              {playlist.length ? (
                <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
                  <div
                    ref={barRef}
                    onClick={handleBarClick}
                    className="relative h-12 w-full cursor-pointer rounded-md border border-line bg-neutral-100"
                    role="slider"
                    aria-label="Recording timeline"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(span.end)}
                    aria-valuenow={Math.round(currentTestTime)}
                    tabIndex={0}
                  >
                    {/* Chunk segment blocks (gaps stay blank). */}
                    {playlist.map((chunk, i) => {
                      const left = ((chunk.offsetSec - span.start) / spanDuration) * 100;
                      const width = (CHUNK_SECONDS / spanDuration) * 100;
                      const isCurrent = i === currentPos;
                      return (
                        <div
                          key={chunk.key}
                          className={`absolute top-1.5 bottom-1.5 rounded-sm ${isCurrent ? "bg-accent" : "bg-accent/40"} ${isCurrent ? "" : "hover:bg-accent/60"}`}
                          style={{ left: `${left}%`, width: `calc(${width}% - 2px)` }}
                          title={`chunk ${chunk.index} · ${formatClock(chunk.offsetSec)}–${formatClock(chunk.endSec)}`}
                        />
                      );
                    })}
                    {/* Minute ticks + labels. */}
                    {ticks.map((tick) => (
                      <div key={tick.sec} className="pointer-events-none absolute top-0 bottom-0" style={{ left: `${tick.pct}%` }}>
                        <div className="h-full w-px bg-line" />
                        <span className="absolute -bottom-5 -translate-x-1/2 text-[10px] text-muted">{formatClock(tick.sec)}</span>
                      </div>
                    ))}
                    {/* SUBMISSION-TIME MARKERS: GREEN tick = valid (Accepted),
                        RED = invalid (failed). Positioned by real submission time
                        on the SAME scale as the chunks; click seeks the video to
                        that moment. Markers outside the recorded span clamp to the
                        nearest edge (still clickable) so a submission just before
                        the first chunk or after the last is never lost. */}
                    {markers.map((marker) => {
                      const clamped = Math.max(span.start, Math.min(marker.offsetSec, span.end));
                      const left = ((clamped - span.start) / spanDuration) * 100;
                      const color = marker.event.valid ? "bg-emerald-500" : "bg-danger";
                      const ring = marker.event.valid ? "ring-emerald-500/40" : "ring-danger/40";
                      const label = `${marker.event.valid ? "✓ Accepted" : `✗ ${marker.event.status || "Failed"}`}`
                        + ` · ${marker.event.challenge_name || marker.event.challenge_slug || "submission"}`
                        + (marker.event.lang ? ` · ${marker.event.lang}` : "")
                        + ` · ${formatClock(marker.offsetSec)}`;
                      return (
                        <button
                          key={marker.event.submission_id}
                          type="button"
                          title={label}
                          aria-label={label}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToTestTime(marker.offsetSec, playing || !videoRef.current?.paused);
                          }}
                          className="absolute -top-1.5 z-20 -translate-x-1/2 cursor-pointer"
                          style={{ left: `${left}%` }}
                        >
                          <span className={`block h-3.5 w-3.5 rounded-full border border-white shadow ring-2 ${ring} ${color} transition-transform hover:scale-125`} />
                          <span className={`mx-auto block h-2 w-0.5 ${color}`} />
                        </button>
                      );
                    })}
                    {/* Playhead. */}
                    <div className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-danger" style={{ left: `${playheadPct}%` }}>
                      <div className="absolute -top-1 -translate-x-1/2 rounded-full border border-white bg-danger px-0 py-0" style={{ width: 8, height: 8 }} />
                    </div>
                  </div>
                  <div className="mt-6 flex items-center justify-between text-[11px] text-muted">
                    <span>{formatClock(span.start)}</span>
                    <span>{playlist.length} chunk(s) · {CHUNK_SECONDS}s each · gaps shown as blanks</span>
                    <span>{formatClock(span.end)}</span>
                  </div>
                  {/* SUBMISSION-TIME MARKERS legend + counts. Hidden entirely when
                      the student has no markers (no endpoint / no submissions). */}
                  {markers.length ? (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3 text-xs text-muted">
                      <span className="font-medium text-ink">Submissions on timeline:</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-3 w-3 rounded-full border border-white bg-emerald-500 ring-2 ring-emerald-500/40" />
                        ✓ {validCount} valid
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-3 w-3 rounded-full border border-white bg-danger ring-2 ring-danger/40" />
                        ✗ {invalidCount} invalid
                      </span>
                      <span className="text-muted/70">Click a marker to jump the recording to that submission.</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
                  <AlertTriangle size={16} className="mr-2 inline" />
                  This session has no screen-recording chunks to play.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

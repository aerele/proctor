import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Eye,
  Film,
  Pause,
  Play,
  RefreshCw,
  Rewind,
  Search,
  SkipForward,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  Video,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAdminSessions, fetchAlerts, fetchMyReviews, fetchRecordingSessions, fetchSessionEvents, fetchSubmissionEvents, reviewNext, submitReviewVerdict } from "./api";
import { describeRecordingContents } from "./admin/sessionDetail";
import {
  DEFAULT_LOG_FILTERS,
  alertsForCandidate,
  buildTimelineLog,
  clusterMarkers,
  filterTimelineLog,
  type TimelineLogEntry,
  type TimelineLogFilters
} from "./recordingTimeline";
import type { AdminSessionDetail, Alert, AlertSeverity, RecordingSession, ReviewMineItem, ReviewVerdict, SessionEventItem, SessionEvidence, SubmissionEvent } from "./types";

// localStorage key for the reviewer's own name so a refresh keeps them reviewing.
const REVIEWER_NAME_KEY = "proctor_reviewer_name";

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

// A RECORDING GAP: a span on the timeline where consecutive chunks' offsets leave
// a blank (recording stopped / chunks missing). Rendered as a hatched span so the
// proctor sees "nothing was recorded here". `fromSec`→`toSec` are test-relative.
type TimelineGap = {
  fromSec: number;
  toSec: number;
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
//
// PERFORMANCE: chunks are sorted by offsetSec (buildPlaylist sorts by index, and
// offsets are monotonic in index for both the real and fallback placement), so we
// BINARY-SEARCH for the candidate instead of an O(n) scan. With 200+ chunks this
// keeps every seek/click/keyboard-nudge O(log n) rather than O(n). We locate the
// last chunk whose offsetSec ≤ testTime, then check it and its neighbour to settle
// containment-vs-nearest. `offsets` is the precomputed sorted offset array.
function chunkPosForTestTime(playlist: TimelineChunk[], offsets: number[], testTime: number): number {
  const n = playlist.length;
  if (!n) return -1;
  // Binary search: largest i with offsets[i] <= testTime (lo..hi over [-1, n-1]).
  let lo = 0;
  let hi = n - 1;
  let floor = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= testTime) {
      floor = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // The containing chunk (if any) is the floor one — its span starts at/before
  // testTime; check whether testTime is still inside it.
  if (floor !== -1 && testTime < playlist[floor].endSec) return floor;
  // Otherwise testTime sits in a gap (or before the first chunk). The nearest
  // chunk is either `floor` (gap before the next chunk) or `floor + 1` (the next
  // chunk's start); compare edge distances. floor === -1 → before everything.
  const lower = floor; // last chunk ending at/before testTime (or -1)
  const upper = floor + 1 < n ? floor + 1 : -1; // first chunk starting after testTime
  if (lower === -1) return upper === -1 ? 0 : upper;
  if (upper === -1) return lower;
  const distLower = testTime - playlist[lower].endSec;
  const distUpper = playlist[upper].offsetSec - testTime;
  return distLower <= distUpper ? lower : upper;
}

// Choose the MAJOR label interval (seconds) from total span so labels never crowd.
// ≤10min→1min, ≤30min→5min, ≤90min→10min, >90min→15min. The minor interval is a
// lighter subdivision (1/5 of major, snapped to a tidy value) for unlabeled ticks.
function tickIntervals(spanSeconds: number): { major: number; minor: number } {
  const minutes = spanSeconds / 60;
  if (minutes <= 10) return { major: 60, minor: 30 }; // 1min labels, 30s minors
  if (minutes <= 30) return { major: 5 * 60, minor: 60 }; // 5min labels, 1min minors
  if (minutes <= 90) return { major: 10 * 60, minor: 2 * 60 }; // 10min labels, 2min minors
  return { major: 15 * 60, minor: 5 * 60 }; // 15min labels, 5min minors
}

// F6.7: severity → marker/dot color classes shared by the timeline alert dots
// and the activity-log rows (critical/warning/info on the standard palette).
const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: "bg-danger",
  warning: "bg-warning",
  info: "bg-accent"
};

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "bg-danger/10 text-danger",
  warning: "bg-warning/10 text-warning",
  info: "bg-accent/10 text-accent"
};

// Parse a "jump to time" string into seconds. Accepts mm:ss, h:mm:ss, a bare
// minutes number (e.g. "75" → 75min) or a decimal minutes (e.g. "12.5"). Returns
// NaN when the input can't be understood so callers can ignore it.
function parseTimeInput(raw: string): number {
  const text = raw.trim();
  if (!text) return NaN;
  if (text.includes(":")) {
    const parts = text.split(":").map((p) => p.trim());
    if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return NaN;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return NaN;
    if (nums.length === 2) return nums[0] * 60 + nums[1]; // mm:ss
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]; // h:mm:ss
    return NaN;
  }
  // Bare number → minutes (the most natural single-number scrub at this scale).
  const minutes = Number(text);
  if (!Number.isFinite(minutes)) return NaN;
  return minutes * 60;
}

type Props = {
  password: string;
  // Global contest filter (App.tsx alertFilters.contest_slug). When set, the
  // recording-sessions picker is scoped to that contest. Empty/undefined = all.
  contestSlug?: string;
  // F6.3: state-based deep link from the admin Sessions detail card — load this
  // candidate's recording on mount, preferring this exact session over the
  // default newest-first pick. One-shot: consumed via onDeepLinkConsumed so a
  // later manual visit to the tab starts blank as before.
  deepLink?: { username: string; sessionId?: string } | null;
  onDeepLinkConsumed?: () => void;
};

export function RecordingReview({ password, contestSlug, deepLink, onDeepLinkConsumed }: Props) {
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
  // F6.7: the active session's proctor EVENT stream (visibility/clipboard/IP/
  // recording-state) + the candidate's ALERTS, for the activity overlay + log.
  // Both degrade to empty (no markers) when unavailable — never block playback.
  const [sessionEvents, setSessionEvents] = useState<SessionEventItem[]>([]);
  const [candidateAlerts, setCandidateAlerts] = useState<Alert[]>([]);
  // Activity-log filter state — everything on by default (usability bar).
  const [logFilters, setLogFilters] = useState<TimelineLogFilters>(DEFAULT_LOG_FILTERS);
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

  // "Jump to time" input (mm:ss / h:mm:ss / bare-minutes), parsed on submit.
  const [jumpInput, setJumpInput] = useState("");
  // A3: the summary-stats card is the first-class readout; the continuous scrubber
  // + its footer are a "timeline detail" drill-down behind this toggle (default on
  // so the existing scrubber stays visible until the operator collapses it).
  const [showTimelineDetail, setShowTimelineDetail] = useState(true);
  // DRAG-SCRUB state: while the playhead is being dragged we show a live preview
  // time WITHOUT seeking the <video> on every mousemove (seek only on release, so
  // a 2-hour scrub stays smooth). `null` when not dragging.
  const [dragTime, setDragTime] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloadRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  // Guards a single in-flight URL refresh so a burst of errors doesn't stampede.
  const refreshingRef = useRef(false);
  // Live drag flag for the window-level mousemove/up listeners (avoids re-binding).
  const draggingRef = useRef(false);

  // ---- REVIEW MODE -------------------------------------------------------
  // "browse" = the existing free username search/playback. "review" = the
  // multi-reviewer one-by-one verdict workflow layered on top of the same player.
  const [mode, setMode] = useState<"browse" | "review">("browse");
  // The reviewer's name (persisted to localStorage so a refresh keeps them in).
  const [reviewerName, setReviewerName] = useState<string>(
    () => window.localStorage.getItem(REVIEWER_NAME_KEY) ?? ""
  );
  const [nameInput, setNameInput] = useState("");
  // The student the server has served this reviewer to watch right now (review
  // mode only). null before the first serve; "" when the queue is done.
  const [reviewUsername, setReviewUsername] = useState<string | null>(null);
  // True when the server returned {done:true} — the reviewer's queue is empty.
  const [reviewDone, setReviewDone] = useState(false);
  // The review endpoints are not deployed yet (a 404 → graceful degrade).
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  // In-flight guard so the big Yes/No buttons can't double-fire.
  const [submitting, setSubmitting] = useState(false);
  // Fetching-the-next-student spinner state.
  const [advancing, setAdvancing] = useState(false);
  // This reviewer's own completed verdicts (header count + re-watch list).
  const [myReviews, setMyReviews] = useState<ReviewMineItem[]>([]);
  const [myReviewsOpen, setMyReviewsOpen] = useState(false);
  // When re-watching a completed review, this holds that username (read-only;
  // the Yes/No controls are hidden and a "viewing a completed review" note shows).
  const [rewatchUsername, setRewatchUsername] = useState<string | null>(null);
  // The username currently loaded into the player (used to detect "no recording").

  // ---- Load the lightweight picker list. Re-runs when the global contest filter
  // changes so the picker stays scoped to the selected contest. ---------------
  useEffect(() => {
    let cancelled = false;
    setPickerLoaded(false);
    void (async () => {
      try {
        const list = await fetchRecordingSessions(password, contestSlug || undefined);
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
  }, [password, contestSlug]);

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

  // PERF: precompute the sorted chunk-offset array ONCE per playlist so every
  // seek/click/keyboard-nudge does an O(log n) binary search instead of an O(n)
  // scan. Memoized on `playlist` (which itself only recomputes on chunks/testStart).
  const offsets = useMemo(() => playlist.map((c) => c.offsetSec), [playlist]);

  // RECORDING GAPS: spans between consecutive chunks where the next chunk starts
  // after the previous one ends (recording stopped / chunks missing). Derived once
  // per playlist. A small tolerance avoids drawing sub-second "gaps" from rounding.
  // These render as distinct hatched blanks on the continuous bar — NOT as 200
  // individual segment divs (only the gaps get a div, typically a handful).
  const gaps = useMemo<TimelineGap[]>(() => {
    const out: TimelineGap[] = [];
    for (let i = 1; i < playlist.length; i += 1) {
      const prevEnd = playlist[i - 1].endSec;
      const nextStart = playlist[i].offsetSec;
      if (nextStart - prevEnd > 0.5) out.push({ fromSec: prevEnd, toSec: nextStart });
    }
    return out;
  }, [playlist]);

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

  // A3: total recording-gap duration (seconds) across all gaps, for the summary card.
  const totalGapSeconds = useMemo(() => gaps.reduce((sum, g) => sum + (g.toSec - g.fromSec), 0), [gaps]);

  // ---- F6.7: activity overlay + log data ----------------------------------
  // Fetch the active session's EVENT stream (per-session) and the candidate's
  // ALERTS (per-candidate over the session's contest scope; archived included —
  // a reviewer wants the full history). Re-runs when the active session
  // changes; both fetches degrade to empty on failure/404.
  useEffect(() => {
    const session = activeSession;
    const sessionId = session?.session_id ? String(session.session_id) : "";
    if (!sessionId) {
      setSessionEvents([]);
      setCandidateAlerts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const events = await fetchSessionEvents(password, sessionId);
        if (!cancelled) setSessionEvents(events ?? []);
      } catch {
        if (!cancelled) setSessionEvents([]);
      }
      try {
        const response = await fetchAlerts(password, {
          contest_slug: session?.contest_slug || undefined,
          include_archived: true
        });
        if (!cancelled) setCandidateAlerts(alertsForCandidate(response.alerts ?? [], session ?? {}));
      } catch {
        if (!cancelled) setCandidateAlerts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.session_id, password]);

  // The merged, time-ordered activity entries (alerts + events + submissions)
  // on the SAME test-relative scale, blackout-tagged via the gap spans — then
  // the filtered view + the per-kind marker lists the overlay renders.
  const logEntries = useMemo(
    () => buildTimelineLog({ alerts: candidateAlerts, events: sessionEvents, submissions: submissionEvents, testStartMs, gaps }),
    [candidateAlerts, sessionEvents, submissionEvents, testStartMs, gaps]
  );
  const visibleLog = useMemo(() => filterTimelineLog(logEntries, logFilters), [logEntries, logFilters]);
  const alertMarkers = useMemo(() => visibleLog.filter((entry) => entry.kind === "alert"), [visibleLog]);
  // Event ticks CLUSTER when closer than ~0.8% of the span (min 2s) so a dense
  // stream stays individually hoverable instead of smearing into a blob.
  const eventClusters = useMemo(
    () => clusterMarkers(visibleLog.filter((entry) => entry.kind === "event"), Math.max(spanDuration * 0.008, 2)),
    [visibleLog, spanDuration]
  );
  const logCounts = useMemo(
    () => ({
      alerts: logEntries.filter((entry) => entry.kind === "alert").length,
      events: logEntries.filter((entry) => entry.kind === "event").length,
      submissions: logEntries.filter((entry) => entry.kind === "submission").length
    }),
    [logEntries]
  );

  // ---- Load a chosen user's sessions (with signed evidence). --------------
  // `silentIfEmpty` (review mode) suppresses the "No sessions found" banner so
  // ReviewModePanel can show its own "No recording found — score anyway" state.
  // `preferSessionId` (F6.3 deep link) selects that exact session when it is
  // among the loaded ones; otherwise the default newest-first pick applies.
  const loadUser = useCallback(
    async (username: string, silentIfEmpty = false, preferSessionId?: string) => {
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
        const preferred = preferSessionId
          ? loaded.find((s) => String(s.session_id) === preferSessionId)
          : undefined;
        const target = preferred ?? newest;
        setSelectedSessionId(target ? String(target.session_id) : "");
        setTestStartInput(isoToLocalInput(target?.created_at));
        setCurrentPos(0);
        setCurrentTestTime(0);
        setPlaying(false);
        if (!loaded.length && !silentIfEmpty) setError(`No sessions found for "${trimmed}".`);

        // Also fetch the student's SUBMISSION-TIME MARKERS. Scope to the chosen
        // session's contest so the markers line up with that test; a 404 (or
        // null) just means no markers — never blocks the recording view.
        try {
          const events = await fetchSubmissionEvents(password, trimmed, target?.contest_slug || undefined);
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

  // F6.3: consume the deep link from the Sessions detail card — load that
  // candidate (preferring the exact session) in Browse mode, then tell the
  // parent it was consumed so the link stays one-shot.
  useEffect(() => {
    if (!deepLink) return;
    setMode("browse");
    void loadUser(deepLink.username, false, deepLink.sessionId);
    onDeepLinkConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink]);

  // ---- REVIEW MODE actions ----------------------------------------------
  // Refresh this reviewer's own completed-verdict list (header count + re-watch
  // list). Tolerant: a null (404) just leaves the list empty.
  const refreshMyReviews = useCallback(
    async (name: string) => {
      if (!name) return;
      try {
        const mine = await fetchMyReviews(password, name);
        setMyReviews(mine?.reviews ?? []);
      } catch {
        // Non-fatal — the count/list just stays as-is.
      }
    },
    [password]
  );

  // Ask the SERVER for the next student to review and load that recording into
  // the existing player. {username} → load it; {done:true} → show the done state;
  // null (404) → show "not deployed yet". Leaving re-watch mode along the way.
  const serveNext = useCallback(
    async (name: string) => {
      if (!name) return;
      setAdvancing(true);
      setError("");
      setRewatchUsername(null);
      try {
        const next = await reviewNext(password, name);
        if (next === null) {
          setReviewUnavailable(true);
          setReviewUsername(null);
          setReviewDone(false);
          return;
        }
        setReviewUnavailable(false);
        if (next.done) {
          setReviewDone(true);
          setReviewUsername(null);
          // Clear the player so the done state isn't sitting behind a stale clip.
          setSessions([]);
          setSubmissionEvents([]);
          return;
        }
        setReviewDone(false);
        setReviewUsername(next.username);
        await loadUser(next.username, true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setAdvancing(false);
      }
    },
    [password, loadUser]
  );

  // Start reviewing under a typed name: persist it, load this reviewer's history,
  // and serve the first student.
  const startReviewing = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      window.localStorage.setItem(REVIEWER_NAME_KEY, trimmed);
      setReviewerName(trimmed);
      setNameInput("");
      setReviewDone(false);
      await refreshMyReviews(trimmed);
      await serveNext(trimmed);
    },
    [refreshMyReviews, serveNext]
  );

  // "Not you? change name" — drop the persisted identity and return to the name
  // prompt without leaving review mode.
  const changeReviewerName = useCallback(() => {
    window.localStorage.removeItem(REVIEWER_NAME_KEY);
    setReviewerName("");
    setNameInput("");
    setReviewUsername(null);
    setReviewDone(false);
    setRewatchUsername(null);
    setMyReviews([]);
    setSessions([]);
    setSubmissionEvents([]);
  }, []);

  // Record a YES(1)/NO(0) verdict for the served student, then serve the next.
  const castVerdict = useCallback(
    async (verdict: ReviewVerdict) => {
      if (!reviewerName || !reviewUsername || submitting) return;
      setSubmitting(true);
      setError("");
      try {
        const ok = await submitReviewVerdict(password, { username: reviewUsername, reviewer_name: reviewerName, verdict });
        if (ok === null) {
          setReviewUnavailable(true);
          return;
        }
        await refreshMyReviews(reviewerName);
        await serveNext(reviewerName);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [password, reviewerName, reviewUsername, submitting, refreshMyReviews, serveNext]
  );

  // "Skip (no verdict)" — leave this student unscored and just ask for the next.
  const skipStudent = useCallback(async () => {
    if (!reviewerName || submitting || advancing) return;
    await serveNext(reviewerName);
  }, [reviewerName, submitting, advancing, serveNext]);

  // Re-watch a COMPLETED review read-only: load that recording WITHOUT changing
  // the served student or the verdict. Clears on the next serve/skip.
  const rewatchReview = useCallback(
    async (username: string) => {
      setRewatchUsername(username);
      setError("");
      await loadUser(username, true);
    },
    [loadUser]
  );

  // On switching INTO review mode with a remembered name (refresh-resume), load
  // the reviewer's history and serve the first student automatically.
  const reviewBootstrappedRef = useRef(false);
  useEffect(() => {
    if (mode !== "review" || !reviewerName) return;
    if (reviewBootstrappedRef.current) return;
    reviewBootstrappedRef.current = true;
    void (async () => {
      await refreshMyReviews(reviewerName);
      await serveNext(reviewerName);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, reviewerName]);

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
      const pos = chunkPosForTestTime(playlist, offsets, testTime);
      if (pos === -1) return;
      const chunk = playlist[pos];
      const withinChunk = Math.max(0, Math.min(testTime - chunk.offsetSec, CHUNK_SECONDS));
      setCurrentPos(pos);
      setCurrentTestTime(testTime);
      loadChunkIntoPlayer(pos, withinChunk, autoplay);
    },
    [playlist, offsets, loadChunkIntoPlayer]
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

  // Whether playback should resume after a programmatic seek (mirrors the player's
  // current intent so a seek doesn't stop a playing recording or start a paused one).
  const wantPlaying = useCallback(() => playing || !videoRef.current?.paused, [playing]);

  // Relative skip by N seconds from the current test-time (used by the skip buttons
  // and arrow-key nudges). Clamps to the span so it never runs off the bar.
  const skipBy = useCallback(
    (deltaSec: number) => {
      if (!playlist.length) return;
      const target = Math.max(span.start, Math.min(currentTestTime + deltaSec, span.end));
      seekToTestTime(target, wantPlaying());
    },
    [playlist.length, span.start, span.end, currentTestTime, seekToTestTime, wantPlaying]
  );

  // PREV / NEXT CHUNK: jump to the start of the adjacent chunk in index order.
  const stepChunk = useCallback(
    (dir: -1 | 1) => {
      if (!playlist.length) return;
      const nextPos = Math.max(0, Math.min(currentPos + dir, playlist.length - 1));
      if (nextPos === currentPos && (dir === -1 ? currentTestTime <= playlist[0].offsetSec : true)) {
        // Already at the boundary chunk; for prev, also rewind within-chunk to its start.
        if (dir === -1) seekToTestTime(playlist[currentPos].offsetSec, wantPlaying());
        return;
      }
      seekToTestTime(playlist[nextPos].offsetSec, wantPlaying());
    },
    [playlist, currentPos, currentTestTime, seekToTestTime, wantPlaying]
  );

  // JUMP TO TIME: parse the input (mm:ss / h:mm:ss / bare minutes) and seek there.
  const handleJump = useCallback(() => {
    const parsed = parseTimeInput(jumpInput);
    if (!Number.isFinite(parsed)) return;
    // The input is relative to the test start; clamp into the recorded span.
    const target = Math.max(span.start, Math.min(parsed, span.end));
    seekToTestTime(target, wantPlaying());
  }, [jumpInput, span.start, span.end, seekToTestTime, wantPlaying]);

  // Convert an absolute clientX on the bar into a test-relative time.
  const timeFromClientX = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return span.start;
      const rect = bar.getBoundingClientRect();
      const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return span.start + Math.max(0, Math.min(1, fraction)) * spanDuration;
    },
    [span.start, spanDuration]
  );

  // DRAG-SCRUB: pressing on the bar starts a drag; window listeners track the move
  // and the release. During the drag we only update `dragTime` (a cheap preview);
  // the actual <video> seek happens once on release so a long scrub stays smooth.
  const startDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!playlist.length) return;
      event.preventDefault();
      draggingRef.current = true;
      setDragTime(timeFromClientX(event.clientX));
    },
    [playlist.length, timeFromClientX]
  );

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      setDragTime(timeFromClientX(event.clientX));
    };
    const onUp = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const target = timeFromClientX(event.clientX);
      setDragTime(null);
      seekToTestTime(target, wantPlaying());
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [timeFromClientX, seekToTestTime, wantPlaying]);

  // REVIEW-MODE KEYBOARD: Y = Yes(1), N = No(0). Only active while a student is
  // served for a fresh verdict (not while re-watching a completed review), and
  // never when typing into an input/textarea/select so the name field is unaffected.
  useEffect(() => {
    if (mode !== "review" || !reviewUsername || rewatchUsername || reviewDone) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const key = event.key.toLowerCase();
      if (key === "y") {
        event.preventDefault();
        void castVerdict(1);
      } else if (key === "n") {
        event.preventDefault();
        void castVerdict(0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, reviewUsername, rewatchUsername, reviewDone, castVerdict]);

  // ARROW-KEY NUDGE when the player area is focused: ←/→ = ±5s, Shift+←/→ = ±30s.
  // Space toggles play/pause. We never hijack keys while an input/select/textarea
  // (or any contenteditable) is focused, so typing in Jump-to-time stays normal.
  const handlePlayerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        skipBy(event.shiftKey ? -30 : -5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        skipBy(event.shiftKey ? 30 : 5);
      } else if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        togglePlay();
      }
    },
    [skipBy, togglePlay]
  );

  // Click on the scrubber bar → seek to that test-time. (A genuine click without a
  // drag; the drag path handles press-move-release on its own.)
  const handleBarClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!playlist.length) return;
      seekToTestTime(timeFromClientX(event.clientX), wantPlaying());
    },
    [playlist.length, seekToTestTime, timeFromClientX, wantPlaying]
  );

  // ADAPTIVE TICKS across the span. The major interval (labeled) is chosen from the
  // total duration so labels never crowd at 2-hour scale; minor ticks (unlabeled,
  // lighter) subdivide between them. Labels use formatClock (h:mm:ss past an hour).
  const { majorTicks, minorTicks } = useMemo(() => {
    const { major, minor } = tickIntervals(spanDuration);
    const majorOut: Array<{ sec: number; pct: number }> = [];
    const minorOut: Array<{ sec: number; pct: number }> = [];
    const firstMajor = Math.ceil(span.start / major) * major;
    for (let sec = firstMajor; sec <= span.end + 0.001; sec += major) {
      majorOut.push({ sec, pct: ((sec - span.start) / spanDuration) * 100 });
    }
    const firstMinor = Math.ceil(span.start / minor) * minor;
    for (let sec = firstMinor; sec <= span.end + 0.001; sec += minor) {
      // Skip minors that coincide with a major tick (avoid double-drawing).
      if (Math.abs(sec % major) < 0.001) continue;
      minorOut.push({ sec, pct: ((sec - span.start) / spanDuration) * 100 });
    }
    return { majorTicks: majorOut, minorTicks: minorOut };
  }, [span.start, span.end, spanDuration]);

  // The time shown at the playhead: the live drag preview while scrubbing, else the
  // real playback time. Playhead percent is derived from this so the handle tracks
  // the cursor during a drag without seeking the video on every move.
  const displayTime = dragTime ?? currentTestTime;
  const playheadPct = Math.max(0, Math.min(100, ((displayTime - span.start) / spanDuration) * 100));
  const playedPct = Math.max(0, Math.min(100, ((currentTestTime - span.start) / spanDuration) * 100));

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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Film size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Recordings</h1>
              <p className="mt-1 text-sm text-muted">
                {mode === "browse"
                  ? "Pick a student and watch their screen recording on a test-relative timeline. Playback advances seamlessly across 30-second chunks."
                  : "Review mode: you are served students one-by-one to watch and give a Yes / No verdict. The server picks who comes next."}
              </p>
            </div>
          </div>
          {/* MODE TOGGLE — Browse (free search) vs Review (one-by-one verdicts). */}
          <div className="inline-flex shrink-0 rounded-md border border-line bg-white p-1" role="tablist" aria-label="Recordings mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "browse"}
              onClick={() => setMode("browse")}
              className={`focus-ring inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium ${mode === "browse" ? "bg-ink text-white" : "text-ink hover:bg-ink/5"}`}
            >
              <Search size={14} /> Browse
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "review"}
              onClick={() => setMode("review")}
              className={`focus-ring inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium ${mode === "review" ? "bg-ink text-white" : "text-ink hover:bg-ink/5"}`}
            >
              <UserCheck size={14} /> Review mode
            </button>
          </div>
        </div>
      </div>

      {/* REVIEW MODE — name gate, reviewer strip, verdict controls. The player on
          the right is the SAME one Browse uses (loaded via loadUser). */}
      {mode === "review" ? (
        reviewUnavailable ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-5 text-sm text-warning">
            <AlertTriangle size={16} className="mr-2 inline" />
            The multi-reviewer review workflow is not deployed yet. Switch to Browse to watch recordings directly, or try again once the review endpoints are live.
          </div>
        ) : !reviewerName ? (
          <ReviewerNameGate
            nameInput={nameInput}
            onNameInput={setNameInput}
            onStart={() => void startReviewing(nameInput)}
            busy={advancing}
          />
        ) : (
          <ReviewModePanel
            reviewerName={reviewerName}
            doneCount={myReviews.length}
            myReviews={myReviews}
            myReviewsOpen={myReviewsOpen}
            onToggleMyReviews={() => setMyReviewsOpen((v) => !v)}
            onChangeName={changeReviewerName}
            onRewatch={(u) => void rewatchReview(u)}
            reviewUsername={reviewUsername}
            reviewDone={reviewDone}
            rewatchUsername={rewatchUsername}
            activeSession={activeSession}
            hasRecording={Boolean(activeSession)}
            loadingUser={loadingUser || advancing}
            submitting={submitting}
            onYes={() => void castVerdict(1)}
            onNo={() => void castVerdict(0)}
            onSkip={() => void skipStudent()}
            onResumeQueue={() => void serveNext(reviewerName)}
            error={error}
          />
        )
      ) : null}

      {/* The player/timeline grid is reused by BOTH modes. In review mode the left
          picker aside is hidden (the server chooses who you watch), so we drop it. */}
      <div className={mode === "review" ? "grid gap-5" : "grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]"}>
        {/* LEFT: username picker (search list, or manual entry when no endpoint).
            Hidden in REVIEW MODE — the server chooses who you watch next. */}
        {mode === "review" ? null : (
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
        )}

        {/* RIGHT: session controls + timeline + player. */}
        <div className="space-y-4">
          {/* In REVIEW MODE the error + verdict chrome live in ReviewModePanel
              above, so suppress the duplicate error banner here. */}
          {error && mode === "browse" ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
          ) : null}

          {loadingUser ? (
            <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-muted">
              <RefreshCw size={18} className="mx-auto animate-spin text-accent" />
              <p className="mt-2">Loading sessions…</p>
            </div>
          ) : !activeSession ? (
            // Review mode shows its own served-student / no-recording / done state
            // in ReviewModePanel, so the right column stays empty until a recording
            // actually loads. Browse mode keeps the "select a student" prompt.
            mode === "review" ? null : (
            <div className="rounded-lg border border-line bg-panel p-8 text-center text-sm text-muted">
              <Film size={22} className="mx-auto text-muted" />
              <p className="mt-3">Select a student to load their screen recording.</p>
            </div>
            )
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
                  {" · "}timeline labels are relative to the test start above ({formatClock(span.end)} long
                  {spanDuration >= 3600 ? ", h:mm:ss" : ", mm:ss"}).
                </p>
                {/* F6.6 — what THIS recording contains, from the session's
                    last-reported capture state (the camera is live-monitor
                    only and is never part of the recorded video). */}
                <p className="mt-1 text-xs text-muted">
                  Recording contains: {describeRecordingContents(activeSession.capture_state)}.
                </p>
              </div>

              {/* PLAYER — focusable wrapper so ARROW KEYS nudge playback (±5s, Shift
                  ±30s) and Space toggles, without hijacking keys typed into inputs. */}
              <div
                ref={playerWrapRef}
                tabIndex={0}
                onKeyDown={handlePlayerKeyDown}
                className="focus-ring overflow-hidden rounded-lg border border-line bg-ink"
              >
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
              <div className="space-y-3 rounded-lg border border-line bg-panel p-3 shadow-subtle">
                {/* Row 1: transport — play/pause, prev/next chunk, ±skip buttons. */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={togglePlay}
                    disabled={!playlist.length}
                    className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />} {playing ? "Pause" : "Play"}
                  </button>

                  {/* PREV / NEXT CHUNK */}
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => stepChunk(-1)}
                      disabled={!playlist.length}
                      title="Previous chunk"
                      aria-label="Previous chunk"
                      className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                    >
                      <ChevronLeft size={14} /> Chunk
                    </button>
                    <button
                      type="button"
                      onClick={() => stepChunk(1)}
                      disabled={!playlist.length}
                      title="Next chunk"
                      aria-label="Next chunk"
                      className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                    >
                      Chunk <ChevronRight size={14} />
                    </button>
                  </div>

                  {/* SKIP buttons: −30s −1m −10s +10s +1m +30s */}
                  <div className="inline-flex items-center gap-1">
                    {([-60, -30, -10] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => skipBy(d)}
                        disabled={!playlist.length}
                        className="focus-ring inline-flex h-9 items-center rounded-md border border-line bg-white px-2 font-mono text-xs text-ink hover:border-ink/40 disabled:opacity-50"
                      >
                        {d === -60 ? "−1m" : `${d}s`}
                      </button>
                    ))}
                    {([10, 30, 60] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => skipBy(d)}
                        disabled={!playlist.length}
                        className="focus-ring inline-flex h-9 items-center rounded-md border border-line bg-white px-2 font-mono text-xs text-ink hover:border-ink/40 disabled:opacity-50"
                      >
                        {d === 60 ? "+1m" : `+${d}s`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Row 2: readout + JUMP-TO-TIME. */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 font-mono text-sm text-ink">
                    <Clock size={14} className="text-muted" />
                    {formatClock(displayTime)} <span className="text-muted">/ {formatClock(span.end)}</span>
                  </span>
                  <span className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                    chunk {playlist.length ? currentPos + 1 : 0} / {playlist.length}
                  </span>

                  {/* JUMP TO TIME — mm:ss, h:mm:ss, or bare minutes. */}
                  <form
                    className="ml-auto inline-flex items-center gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleJump();
                    }}
                  >
                    <label className="text-xs text-muted" htmlFor="jump-to-time">
                      Jump to
                    </label>
                    <input
                      id="jump-to-time"
                      value={jumpInput}
                      onChange={(event) => setJumpInput(event.target.value)}
                      placeholder="mm:ss / h:mm:ss"
                      inputMode="numeric"
                      className="focus-ring h-9 w-32 rounded-md border border-line bg-white px-2.5 font-mono text-xs text-ink"
                    />
                    <button
                      type="submit"
                      disabled={!playlist.length || !Number.isFinite(parseTimeInput(jumpInput))}
                      title="Jump to time"
                      aria-label="Jump to time"
                      className="focus-ring inline-flex h-9 items-center gap-1 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                    >
                      <Rewind size={13} /> Go
                    </button>
                  </form>

                  {refreshNote ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs text-accent">
                      <RefreshCw size={12} /> {refreshNote}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* SUMMARY STATS — a first-class readout of the loaded recording:
                  chunks, sessions, events (valid/invalid), time range, and
                  recording gaps. Always shown; the continuous scrubber below is a
                  drill-down behind the "Show timeline detail" toggle. */}
              <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Summary</h2>
                  <button
                    type="button"
                    onClick={() => setShowTimelineDetail((v) => !v)}
                    aria-expanded={showTimelineDetail}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                  >
                    {showTimelineDetail ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {showTimelineDetail ? "Hide timeline detail" : "Show timeline detail"}
                  </button>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  <SummaryStat label="Total chunks" value={String(playlist.length)} />
                  <SummaryStat label="Sessions covered" value={String(sessions.length)} />
                  <SummaryStat
                    label="Events processed"
                    value={String(markers.length)}
                    hint={markers.length ? `✓ ${validCount} valid · ✗ ${invalidCount} invalid` : "no submission events"}
                  />
                  <SummaryStat
                    label="Time range"
                    value={`${formatClock(span.start)}–${formatClock(span.end)}`}
                  />
                  <SummaryStat
                    label="Recording gaps"
                    value={String(gaps.length)}
                    hint={gaps.length ? `${formatClock(totalGapSeconds)} total` : "no gaps"}
                  />
                </dl>
              </div>

              {/* TIMELINE scrubber — drill-down behind the summary toggle. */}
              {showTimelineDetail ? (
              <>
              {playlist.length ? (
                <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
                  {/* The bar carries generous vertical padding: VALID submission
                      markers sit ABOVE the track, INVALID ones BELOW, so the two
                      classes never overlap even when densely packed. The continuous
                      track itself is a single element (played fill + base), NOT one
                      div per chunk — only recording GAPS get their own hatched span. */}
                  <div
                    ref={barRef}
                    onClick={handleBarClick}
                    onMouseDown={startDrag}
                    className="relative h-9 w-full cursor-pointer select-none rounded-md"
                    role="slider"
                    aria-label="Recording timeline"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(span.end)}
                    aria-valuenow={Math.round(displayTime)}
                    tabIndex={0}
                  >
                    {/* CONTINUOUS TRACK: a single base bar (full recorded span) with
                        a played-portion fill. No per-chunk divs. */}
                    <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 overflow-hidden rounded-full border border-line bg-accent/25">
                      <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${playedPct}%` }} />
                    </div>

                    {/* RECORDING GAPS: distinct hatched blank spans where the
                        recording stopped / chunks are missing. Only the (few) gaps
                        render, so this stays cheap at 200+ chunks. */}
                    {gaps.map((gap) => {
                      const left = ((gap.fromSec - span.start) / spanDuration) * 100;
                      const width = ((gap.toSec - gap.fromSec) / spanDuration) * 100;
                      return (
                        <div
                          key={`gap-${gap.fromSec}`}
                          className="pointer-events-none absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border border-warning/50"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            backgroundImage:
                              "repeating-linear-gradient(45deg, rgba(217,119,6,0.18) 0, rgba(217,119,6,0.18) 3px, transparent 3px, transparent 6px)"
                          }}
                          title={`Recording gap · ${formatClock(gap.fromSec)}–${formatClock(gap.toSec)}`}
                        />
                      );
                    })}

                    {/* MINOR ticks (lighter, unlabeled). */}
                    {minorTicks.map((tick) => (
                      <div
                        key={`minor-${tick.sec}`}
                        className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-line/60"
                        style={{ left: `${tick.pct}%` }}
                      />
                    ))}
                    {/* MAJOR ticks + labels (adaptive interval, h:mm:ss past 1h). */}
                    {majorTicks.map((tick) => (
                      <div key={`major-${tick.sec}`} className="pointer-events-none absolute bottom-0 top-0" style={{ left: `${tick.pct}%` }}>
                        <div className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-line" />
                        <span className="absolute -bottom-5 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted">
                          {formatClock(tick.sec)}
                        </span>
                      </div>
                    ))}

                    {/* SUBMISSION-TIME MARKERS as THIN 2px ticks. VALID (green) sit
                        ABOVE the track, INVALID (red) BELOW, so the two classes stay
                        separable even when many land within a few px. Each keeps a
                        small invisible hit-area so it's individually hoverable and
                        clickable at density (they never merge into a blob). Hover
                        shows the existing tooltip; click seeks to that submission. */}
                    {markers.map((marker) => {
                      const clamped = Math.max(span.start, Math.min(marker.offsetSec, span.end));
                      const left = ((clamped - span.start) / spanDuration) * 100;
                      const valid = marker.event.valid;
                      const color = valid ? "bg-emerald-500" : "bg-danger";
                      const label =
                        `${valid ? "✓ Accepted" : `✗ ${marker.event.status || "Failed"}`}` +
                        ` · ${marker.event.challenge_name || marker.event.challenge_slug || "submission"}` +
                        (marker.event.lang ? ` · ${marker.event.lang}` : "") +
                        ` · ${formatClock(marker.offsetSec)}`;
                      return (
                        <button
                          key={marker.event.submission_id}
                          type="button"
                          title={label}
                          aria-label={label}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToTestTime(marker.offsetSec, wantPlaying());
                          }}
                          className={`group absolute z-20 -translate-x-1/2 cursor-pointer ${valid ? "top-0" : "bottom-0"}`}
                          style={{ left: `${left}%` }}
                        >
                          {/* Invisible widened hit-area for easy hover at density. */}
                          <span className="absolute -inset-x-1.5 inset-y-0" />
                          <span
                            className={`block h-3 w-0.5 ${color} transition-transform group-hover:scale-y-150 group-hover:opacity-100`}
                          />
                        </button>
                      );
                    })}

                    {/* ALERT MARKERS (F6.7) — severity-colored DOTS riding the
                        track center: a distinct shape from the thin submission
                        ticks above/below, white-ringed so they read against the
                        fill and gaps. Hover gives headline + time (+ blackout);
                        click jumps the recording there. */}
                    {alertMarkers.map((entry) => {
                      const clamped = Math.max(span.start, Math.min(entry.offsetSec, span.end));
                      const left = ((clamped - span.start) / spanDuration) * 100;
                      const label = `⚠ ${entry.label} · ${formatClock(entry.offsetSec)}${entry.duringGap ? " · during blackout" : ""}`;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          title={label}
                          aria-label={label}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            seekToTestTime(clamped, wantPlaying());
                          }}
                          className="group absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
                          style={{ left: `${left}%` }}
                        >
                          {/* Invisible widened hit-area for easy hover at density. */}
                          <span className="absolute -inset-1.5" />
                          <span
                            className={`block h-2.5 w-2.5 rounded-full ring-2 ring-white ${SEVERITY_DOT[entry.severity ?? "info"]} transition-transform group-hover:scale-125`}
                          />
                        </button>
                      );
                    })}

                    {/* DRAGGABLE PLAYHEAD with a live readout (shown while dragging). */}
                    <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: `${playheadPct}%` }}>
                      <div className="absolute top-1/2 h-7 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-ink" />
                      <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-ink shadow" />
                      {dragTime !== null ? (
                        <div className="absolute -top-7 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 font-mono text-[10px] text-white shadow">
                          {formatClock(displayTime)}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* EVENT LANE (F6.7) — the candidate's proctor events as
                      SUBDUED ticks on a slim strip aligned under the scrubber
                      (kept off the main bar so it stays clean at zoom-out).
                      Near-coincident events cluster into one slightly wider
                      tick whose tooltip lists them; click seeks to the first. */}
                  {eventClusters.length ? (
                    // mt-6 clears the major-tick labels hanging below the bar.
                    <div className="relative mt-6 h-3 w-full" aria-label="Candidate events lane">
                      {eventClusters.map((cluster) => {
                        const clamped = Math.max(span.start, Math.min(cluster.offsetSec, span.end));
                        const left = ((clamped - span.start) / spanDuration) * 100;
                        const head = cluster.entries.slice(0, 3).map((entry) => entry.label);
                        const more = cluster.entries.length - head.length;
                        const label = `${head.join(" · ")}${more > 0 ? ` · +${more} more` : ""} · ${formatClock(cluster.offsetSec)}`;
                        return (
                          <button
                            key={`evc-${cluster.entries[0].id}`}
                            type="button"
                            title={label}
                            aria-label={label}
                            onClick={() => seekToTestTime(clamped, wantPlaying())}
                            className="group absolute top-0 -translate-x-1/2 cursor-pointer"
                            style={{ left: `${left}%` }}
                          >
                            <span className="absolute -inset-x-1.5 inset-y-0" />
                            <span
                              className={`block h-2.5 ${cluster.entries.length > 1 ? "w-1 rounded-sm" : "w-0.5"} bg-muted/60 transition group-hover:bg-ink`}
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* mt-6 clears the tick labels; the event lane (when shown)
                      already did, so only a small gap is needed after it. */}
                  <div className={`${eventClusters.length ? "mt-2" : "mt-6"} flex items-center justify-between text-[11px] text-muted`}>
                    <span>{formatClock(span.start)}</span>
                    <span>
                      {playlist.length} chunk(s) · {CHUNK_SECONDS}s each
                      {gaps.length ? ` · ${gaps.length} recording gap${gaps.length > 1 ? "s" : ""}` : " · no gaps"}
                    </span>
                    <span>{formatClock(span.end)}</span>
                  </div>

                  {/* Navigation hint. */}
                  <p className="mt-1 text-[11px] text-muted/80">
                    Drag the playhead or click the bar to scrub · arrow keys ±5s (Shift ±30s) when the player is
                    focused · gaps shown as hatched blanks.
                  </p>

                  {/* MARKER LEGEND — submissions (ticks above/below), alerts
                      (severity dots on the track) and events (subdued lane
                      below). Hidden entirely when nothing is overlaid. */}
                  {markers.length || alertMarkers.length || eventClusters.length ? (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3 text-xs text-muted">
                      <span className="font-medium text-ink">On the timeline:</span>
                      {markers.length ? (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-3.5 w-0.5 bg-emerald-500" /> above
                            <span className="font-medium text-ink">✓ {validCount} valid</span>
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-3.5 w-0.5 bg-danger" /> below
                            <span className="font-medium text-ink">✗ {invalidCount} invalid</span>
                          </span>
                        </>
                      ) : null}
                      {alertMarkers.length ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-white" />
                          <span className="font-medium text-ink">{alertMarkers.length} alert{alertMarkers.length > 1 ? "s" : ""}</span>
                          on the track
                        </span>
                      ) : null}
                      {eventClusters.length ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-0.5 bg-muted/60" />
                          <span className="font-medium text-ink">{logCounts.events} event{logCounts.events > 1 ? "s" : ""}</span>
                          in the lane below
                        </span>
                      ) : null}
                      <span className="text-muted/70">Hover a marker for details · click to jump the recording there.</span>
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
              ) : null}

              {/* F6.7 ACTIVITY LOG — alerts + events + submissions merged
                  time-ordered with kind/severity filters; click a row to jump
                  the player there. Outside the timeline-detail toggle so the
                  log keeps working with the scrubber collapsed. */}
              {logEntries.length ? (
                <ActivityLogPanel
                  entries={visibleLog}
                  counts={logCounts}
                  filters={logFilters}
                  onFilters={setLogFilters}
                  onJump={(offsetSec) =>
                    seekToTestTime(Math.max(span.start, Math.min(offsetSec, span.end)), wantPlaying())
                  }
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// A3: one labeled metric cell inside the recording-review SUMMARY STATS card.
function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-line bg-white/60 p-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold text-ink">{value}</dd>
      {hint ? <dd className="mt-0.5 text-[11px] text-muted">{hint}</dd> : null}
    </div>
  );
}

// F6.7 — one kind-toggle chip in the activity-log header (Alerts / Events /
// Submissions with their counts). Filled when active, outlined when off.
function LogFilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`focus-ring inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
        active ? "border-ink bg-ink text-white" : "border-line bg-white text-muted hover:border-ink/40"
      }`}
    >
      {label}
    </button>
  );
}

// F6.7 — the ACTIVITY LOG card: the merged alert/event/submission entries as a
// time-ordered, click-to-jump list. Each row carries the test-relative clock,
// the absolute wall time, a one-line label + detail, the alert severity where
// applicable, and a "during blackout" tag when the moment has no footage.
function ActivityLogPanel({
  entries,
  counts,
  filters,
  onFilters,
  onJump
}: {
  entries: TimelineLogEntry[];
  counts: { alerts: number; events: number; submissions: number };
  filters: TimelineLogFilters;
  onFilters: (next: TimelineLogFilters) => void;
  onJump: (offsetSec: number) => void;
}) {
  const total = counts.alerts + counts.events + counts.submissions;
  return (
    <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Activity size={15} /> Activity log
          <span className="font-normal normal-case text-muted/80">
            {entries.length === total ? `${total} entries` : `${entries.length} of ${total}`}
          </span>
        </h2>
        {/* Kind toggles + alert-severity narrowing (defaults: everything on). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <LogFilterChip
            active={filters.alerts}
            label={`Alerts ${counts.alerts}`}
            onClick={() => onFilters({ ...filters, alerts: !filters.alerts })}
          />
          <LogFilterChip
            active={filters.events}
            label={`Events ${counts.events}`}
            onClick={() => onFilters({ ...filters, events: !filters.events })}
          />
          <LogFilterChip
            active={filters.submissions}
            label={`Submissions ${counts.submissions}`}
            onClick={() => onFilters({ ...filters, submissions: !filters.submissions })}
          />
          <select
            className="focus-ring h-7 rounded-md border border-line bg-white px-2 text-xs text-ink disabled:opacity-50"
            value={filters.severity}
            onChange={(event) => onFilters({ ...filters, severity: event.target.value as TimelineLogFilters["severity"] })}
            disabled={!filters.alerts}
            aria-label="Alert severity filter"
            title="Narrow the alert rows by severity"
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      {entries.length ? (
        <ol className="mt-3 max-h-80 divide-y divide-line/60 overflow-auto">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onJump(entry.offsetSec)}
                title={`Jump the recording to ${formatClock(entry.offsetSec)}`}
                className="focus-ring flex w-full items-start gap-3 rounded px-1.5 py-2 text-left hover:bg-ink/5"
              >
                {/* Kind dot: alert = severity color, event = subdued, submission
                    = green/red by validity (matches the timeline markers). */}
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    entry.kind === "alert"
                      ? SEVERITY_DOT[entry.severity ?? "info"]
                      : entry.kind === "submission"
                        ? entry.valid
                          ? "bg-emerald-500"
                          : "bg-danger"
                        : "bg-muted/60"
                  }`}
                />
                <span className="w-16 shrink-0 pt-0.5 font-mono text-xs font-medium text-ink">
                  {formatClock(entry.offsetSec)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-ink">{entry.label}</span>
                    {entry.kind === "alert" ? (
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_BADGE[entry.severity ?? "info"]}`}>
                        {entry.severity}
                      </span>
                    ) : null}
                    {entry.duringGap ? (
                      <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        during blackout
                      </span>
                    ) : null}
                  </span>
                  {entry.detail ? <span className="mt-0.5 block truncate text-xs text-muted">{entry.detail}</span> : null}
                </span>
                <span className="shrink-0 pt-0.5 text-[11px] text-muted" title={entry.timestamp}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 rounded-md border border-line bg-white/60 px-3 py-2 text-xs text-muted">
          Nothing matches the current filters.
        </p>
      )}
    </div>
  );
}

// REVIEW MODE — name gate. Centered card shown when no reviewer name is set yet.
// Persisting the name (done by the caller) keeps the reviewer in across refreshes.
function ReviewerNameGate({
  nameInput,
  onNameInput,
  onStart,
  busy
}: {
  nameInput: string;
  onNameInput: (value: string) => void;
  onStart: () => void;
  busy: boolean;
}) {
  return (
    <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
      <UserCheck size={28} className="mx-auto text-accent" />
      <h2 className="mt-3 text-xl font-semibold text-ink">Enter your name to start reviewing</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        You will be served students one at a time. Watch each recording, then give a Yes or No verdict. Your name is saved on this device so a refresh keeps you reviewing.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <input
          autoFocus
          className="focus-ring h-11 w-full rounded-md border border-line bg-white px-3 text-center text-sm"
          placeholder="Your name (e.g. Priya)"
          value={nameInput}
          onChange={(event) => onNameInput(event.target.value)}
        />
        <button
          type="submit"
          disabled={!nameInput.trim() || busy}
          className="focus-ring inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? <RefreshCw size={16} className="animate-spin" /> : <UserCheck size={16} />}
          {busy ? "Starting…" : "Start reviewing"}
        </button>
      </form>
    </section>
  );
}

// REVIEW MODE — the reviewer strip (name · N done · Your reviews) plus the
// prominent verdict controls. The recording player itself is rendered by the
// shared right column below; this panel sits above it and drives the workflow.
function ReviewModePanel({
  reviewerName,
  doneCount,
  myReviews,
  myReviewsOpen,
  onToggleMyReviews,
  onChangeName,
  onRewatch,
  reviewUsername,
  reviewDone,
  rewatchUsername,
  activeSession,
  hasRecording,
  loadingUser,
  submitting,
  onYes,
  onNo,
  onSkip,
  onResumeQueue,
  error
}: {
  reviewerName: string;
  doneCount: number;
  myReviews: ReviewMineItem[];
  myReviewsOpen: boolean;
  onToggleMyReviews: () => void;
  onChangeName: () => void;
  onRewatch: (username: string) => void;
  reviewUsername: string | null;
  reviewDone: boolean;
  rewatchUsername: string | null;
  activeSession: AdminSessionDetail | undefined;
  hasRecording: boolean;
  loadingUser: boolean;
  submitting: boolean;
  onYes: () => void;
  onNo: () => void;
  onSkip: () => void;
  onResumeQueue: () => void;
  error: string;
}) {
  // The served student's display fields (from the loaded session, if any).
  const displayName = activeSession?.name;
  const room = activeSession?.room;
  return (
    <section className="space-y-4">
      {/* HEADER STRIP: reviewer name · N done · change name · Your reviews toggle. */}
      <div className="rounded-lg border border-ink/20 bg-ink/5 p-4 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserCheck size={20} className="text-accent" />
            <div>
              <p className="text-sm font-semibold text-ink">
                Reviewer: <span className="font-mono">{reviewerName}</span>
                <span className="text-muted"> · {doneCount} done</span>
              </p>
              <button
                type="button"
                onClick={onChangeName}
                className="focus-ring mt-0.5 text-xs text-muted underline-offset-2 hover:underline"
              >
                Not you? Change name
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleMyReviews}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
            aria-expanded={myReviewsOpen}
          >
            {myReviewsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Your reviews ({myReviews.length})
          </button>
        </div>

        {/* Collapsible "Your reviews" list — click an entry to RE-WATCH it
            read-only (no verdict change). */}
        {myReviewsOpen ? (
          <div className="mt-3 max-h-56 space-y-1.5 overflow-auto border-t border-ink/10 pt-3">
            {myReviews.length ? (
              myReviews.map((r) => (
                <button
                  key={`${r.username}-${r.created_at}`}
                  type="button"
                  onClick={() => onRewatch(r.username)}
                  className={`focus-ring flex w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm hover:border-ink/40 ${rewatchUsername === r.username ? "border-ink/50 bg-white" : "border-line bg-white/60"}`}
                  title="Re-watch this completed review (read-only)"
                >
                  <span className="truncate font-mono text-ink">{r.username}</span>
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold ${r.verdict === 1 ? "text-emerald-600" : "text-danger"}`}>
                    {r.verdict === 1 ? <><Check size={14} /> Yes</> : <><X size={14} /> No</>}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-1 py-1 text-xs text-muted">No reviews yet — your verdicts will appear here.</p>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      ) : null}

      {/* MAIN REVIEW STATE — done / re-watch note / served student + verdicts. */}
      {reviewDone ? (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-8 text-center shadow-subtle">
          <p className="text-3xl">🎉</p>
          <h3 className="mt-2 text-xl font-semibold text-ink">All assigned students reviewed</h3>
          <p className="mt-2 text-sm leading-6 text-muted">Nothing left in your queue. New students assigned to you will appear when you check again.</p>
          <button
            type="button"
            onClick={onResumeQueue}
            disabled={loadingUser}
            className="focus-ring mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-ink hover:border-ink/40 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loadingUser ? "animate-spin" : undefined} /> Check for more
          </button>
        </div>
      ) : rewatchUsername ? (
        // RE-WATCH a completed review: read-only, no verdict controls.
        <div className="rounded-lg border border-accent/30 bg-accent/10 p-4 shadow-subtle">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-accent">
              <Eye size={16} /> Viewing a completed review of <span className="font-mono">{rewatchUsername}</span> — your verdict is unchanged.
            </p>
            <button
              type="button"
              onClick={onResumeQueue}
              disabled={loadingUser}
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              <SkipForward size={16} /> Back to reviewing
            </button>
          </div>
        </div>
      ) : reviewUsername ? (
        // SERVED student — show who, then the big verdict controls. If no recording
        // was found for them, say so but STILL allow scoring (plus Skip).
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">Now reviewing</p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {displayName ? `${displayName} ` : ""}
              <span className="font-mono text-base text-muted">{reviewUsername}</span>
              {room ? <span className="text-sm font-normal text-muted"> · Room {room}</span> : null}
            </p>
            {loadingUser ? (
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
                <RefreshCw size={12} className="animate-spin" /> Loading recording…
              </p>
            ) : !hasRecording ? (
              <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                <AlertTriangle size={16} /> No recording found for {reviewUsername}. You can still give a verdict, or Skip to the next student.
              </p>
            ) : null}
          </div>

          {/* PROMINENT VERDICT CONTROLS — big green Yes(1) / red No(0). Repeated
              100s of times, so they are large and unmissable. Keyboard: Y / N. */}
          <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={onYes}
                disabled={submitting || loadingUser}
                className="focus-ring inline-flex h-20 items-center justify-center gap-3 rounded-lg bg-emerald-600 text-2xl font-bold text-white shadow-subtle transition hover:bg-emerald-700 disabled:opacity-50"
              >
                <ThumbsUp size={28} /> Yes (1)
              </button>
              <button
                type="button"
                onClick={onNo}
                disabled={submitting || loadingUser}
                className="focus-ring inline-flex h-20 items-center justify-center gap-3 rounded-lg bg-danger text-2xl font-bold text-white shadow-subtle transition hover:bg-red-700 disabled:opacity-50"
              >
                <ThumbsDown size={28} /> No (0)
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">
                Keyboard: press <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono">Y</kbd> for Yes,{" "}
                <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono">N</kbd> for No.
                {submitting ? <span className="ml-2 inline-flex items-center gap-1 text-accent"><RefreshCw size={12} className="animate-spin" /> Saving…</span> : null}
              </p>
              {!hasRecording ? (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={submitting || loadingUser}
                  className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                >
                  <SkipForward size={16} /> Skip (no verdict)
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        // Between serves (initial load).
        <div className="rounded-lg border border-line bg-panel p-8 text-center text-sm text-muted">
          <RefreshCw size={18} className="mx-auto animate-spin text-accent" />
          <p className="mt-2">Finding the next student for you…</p>
        </div>
      )}
    </section>
  );
}

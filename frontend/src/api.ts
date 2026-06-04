import type { HeartbeatResponse, ProctorEvent, ProctorSettings, ReviewNature, SessionStartResponse, StudentForm, UploadManifestItem, UploadUrlResponse } from "./types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
const demoSettingsKey = "aerele-proctor-demo-settings";
export const adminPassword = import.meta.env.VITE_ADMIN_PASSWORD ?? "";

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!apiBaseUrl && !demoMode) {
    throw new Error("VITE_API_BASE_URL is not configured.");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(parseErrorMessage(errorText) || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function parseErrorMessage(errorText: string) {
  if (!errorText) return "";
  try {
    const parsed = JSON.parse(errorText) as { error?: unknown; detail?: unknown };
    return String(parsed.error || parsed.detail || errorText);
  } catch {
    return errorText;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function startSession(form: StudentForm): Promise<SessionStartResponse> {
  if (demoMode) {
    await wait(250);
    const settings = getDemoSettings();
    if (!settings?.passcode) {
      throw new Error("Proctoring is not configured yet. Ask the administrator to set the schedule and passcode.");
    }
    const now = Date.now();
    if (settings.start_at && now < Date.parse(settings.start_at)) {
      throw new Error("Proctoring has not started yet.");
    }
    if (settings.end_at && now > Date.parse(settings.end_at)) {
      throw new Error("Proctoring has ended.");
    }
    if (form.proctor_passcode !== settings.passcode) {
      throw new Error("Invalid proctoring passcode.");
    }
    return {
      session_id: crypto.randomUUID(),
      start_ip: "demo.local",
      contest_url: settings.contest_url || "",
      upload_config: {
        chunk_seconds: 20,
        video_bits_per_second: 750_000,
        media_bits_per_second: 180_000,
        audio_bits_per_second: 32_000,
        max_width: 1280,
        max_frame_rate: 5
      },
      heartbeat_interval_seconds: 15
    };
  }

  return request<SessionStartResponse>("/api/session/start", {
    method: "POST",
    body: JSON.stringify(form)
  });
}

export async function fetchProctorSettings(password: string): Promise<ProctorSettings> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const settings = getDemoSettings();
    return settings ? { ...settings, passcode: "", end_code: "", passcode_set: Boolean(settings.passcode), passcode_preview: maskPasscode(settings.passcode), end_code_set: Boolean(settings.end_code), end_code_preview: maskPasscode(settings.end_code) } : { start_at: "", end_at: "", passcode_set: false, end_code_set: false };
  }

  return request<ProctorSettings>("/api/admin/settings", {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

export async function saveProctorSettings(password: string, settings: ProctorSettings): Promise<ProctorSettings> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const next = {
      start_at: settings.start_at,
      end_at: settings.end_at,
      contest_url: settings.contest_url || "",
      passcode: settings.passcode || getDemoSettings()?.passcode || "",
      end_code: settings.end_code || getDemoSettings()?.end_code || "",
      updated_at: new Date().toISOString()
    };
    if (!next.start_at || !next.end_at || !next.passcode || !next.end_code) {
      throw new Error("Start time, end time, passcode, and end code are required.");
    }
    window.localStorage.setItem(demoSettingsKey, JSON.stringify(next));
    return { ...next, passcode: "", end_code: "", passcode_set: true, passcode_preview: maskPasscode(next.passcode), end_code_set: true, end_code_preview: maskPasscode(next.end_code) };
  }

  return request<ProctorSettings>("/api/admin/settings", {
    method: "POST",
    headers: {
      "x-admin-password": password
    },
    body: JSON.stringify(settings)
  });
}

export async function getUploadUrl(params: {
  session_id: string;
  kind: string;
  chunk_index: number;
  content_type: string;
}): Promise<UploadUrlResponse> {
  if (demoMode) {
    await wait(40);
    return {
      upload_url: "demo://upload",
      storage_key: `demo/${params.session_id}/${params.kind}-${params.chunk_index}.webm`,
      expires_in: 900
    };
  }

  return request<UploadUrlResponse>("/api/upload-url", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function uploadBlob(uploadUrl: string, blob: Blob): Promise<void> {
  if (demoMode || uploadUrl.startsWith("demo://")) {
    await wait(80);
    return;
  }

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": blob.type || "application/octet-stream"
    },
    body: blob
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
}

export async function sendEvents(sessionId: string, events: ProctorEvent[]): Promise<void> {
  if (!events.length) return;
  if (demoMode) {
    await wait(50);
    return;
  }

  await request<{ ok: boolean }>("/api/events", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, events })
  });
}

export async function uploadReviewFile(sessionId: string, nature: ReviewNature, records: Array<Record<string, unknown>>): Promise<void> {
  if (!records.length) return;
  if (demoMode) {
    await wait(50);
    return;
  }

  await request<{ ok: boolean; storage_key: string }>("/api/review-file", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, nature, records })
  });
}

export async function heartbeat(params: {
  session_id: string;
  recording_state: string;
  visibility_state: DocumentVisibilityState;
  upload_queue_depth: number;
  client_time: string;
  network_online: boolean;
}): Promise<HeartbeatResponse> {
  if (demoMode) return { ok: true, start_ip: "demo.local", current_ip: "demo.local", ip_changed: false, newly_changed: false };
  return request<HeartbeatResponse>("/api/heartbeat", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function endSession(params: { sessionId: string; manifest: UploadManifestItem[]; endCode: string; assuranceAccepted: boolean }): Promise<void> {
  if (demoMode) {
    await wait(250);
    const settings = getDemoSettings();
    if (!params.assuranceAccepted) {
      throw new Error("Integrity assurance is required before ending the test.");
    }
    if (!settings?.end_code || params.endCode !== settings.end_code) {
      throw new Error("Invalid proctoring end code.");
    }
    return;
  }

  await request<{ ok: boolean }>("/api/session/end", {
    method: "POST",
    body: JSON.stringify({
      session_id: params.sessionId,
      manifest: params.manifest,
      end_proctor_code: params.endCode,
      assurance_accepted: params.assuranceAccepted
    })
  });
}

export async function validateEndSession(params: { sessionId: string; endCode: string; assuranceAccepted: boolean }): Promise<void> {
  if (demoMode) {
    await wait(100);
    const settings = getDemoSettings();
    if (!params.assuranceAccepted) {
      throw new Error("Integrity assurance is required before ending the test.");
    }
    if (!settings?.end_code || params.endCode !== settings.end_code) {
      throw new Error("Invalid proctoring end code.");
    }
    return;
  }

  await request<{ ok: boolean }>("/api/session/validate-end", {
    method: "POST",
    body: JSON.stringify({
      session_id: params.sessionId,
      end_proctor_code: params.endCode,
      assurance_accepted: params.assuranceAccepted
    })
  });
}

export async function fetchAdminSessions(username: string, password: string) {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return { sessions: [] };
  }

  return request<{
    sessions: Array<Record<string, unknown>>;
  }>(`/api/admin/sessions?username=${encodeURIComponent(username)}`, {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

function assertDemoAdmin(password: string) {
  if (password !== adminPassword) {
    throw new Error("Invalid admin password.");
  }
}

function getDemoSettings(): (ProctorSettings & { passcode?: string; end_code?: string }) | null {
  const raw = window.localStorage.getItem(demoSettingsKey);
  return raw ? JSON.parse(raw) : null;
}

function maskPasscode(value = "") {
  if (!value) return "";
  return `${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
}

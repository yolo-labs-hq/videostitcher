import { promises as fs } from "node:fs";

/**
 * Minimal Gemini REST client (Node 20 global fetch — no SDK dependency).
 * Covers the `analyze` stage: resumable video upload → poll until ACTIVE →
 * generateContent with a structured JSON response schema.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

function baseUrl(): string {
  return process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export function resolveApiKey(explicit?: string): string {
  // Scoped to videostitcher so host coding-agent env (gemini CLI's
  // GEMINI_API_KEY / GOOGLE_API_KEY) doesn't bleed into the tile.
  const key = explicit || process.env.VIDEOSTITCHER_GEMINI_API_KEY;
  if (!key) {
    throw new Error("no Gemini API key — set VIDEOSTITCHER_GEMINI_API_KEY (or pass --api-key)");
  }
  return key;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/mp4",
};

export function mimeForVideo(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_BY_EXT[ext] || "video/mp4";
}

async function readBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
  } catch {
    return "";
  }
}

export interface UploadedFile {
  name: string; // "files/abc123"
  uri: string; // fileUri for generateContent
  mimeType: string;
  state: string;
}

/**
 * Upload a video via the resumable protocol: a `start` request returns an
 * upload URL, then the bytes are sent with `upload, finalize`.
 */
export async function uploadVideo(params: {
  apiKey: string;
  filePath: string;
  mimeType: string;
  displayName: string;
}): Promise<UploadedFile> {
  const bytes = await fs.readFile(params.filePath);
  const startRes = await fetch(`${baseUrl()}/upload/v1beta/files?key=${params.apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": params.mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: params.displayName } }),
  });
  if (!startRes.ok) {
    throw new GeminiError(`upload start failed (${startRes.status})`, startRes.status, await readBody(startRes));
  }
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new GeminiError("upload start did not return an upload URL", startRes.status, "");
  }

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    throw new GeminiError(`upload failed (${uploadRes.status})`, uploadRes.status, await readBody(uploadRes));
  }
  const data = (await uploadRes.json()) as { file?: GeminiFile };
  if (!data.file?.name || !data.file?.uri) {
    throw new GeminiError("upload response missing file name/uri", uploadRes.status, JSON.stringify(data));
  }
  return {
    name: data.file.name,
    uri: data.file.uri,
    mimeType: data.file.mimeType || params.mimeType,
    state: data.file.state || "PROCESSING",
  };
}

interface GeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

/** Poll files.get until the upload finishes processing (state ACTIVE). */
export async function waitForActive(params: {
  apiKey: string;
  name: string;
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (state: string) => void;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 5 * 60_000;
  const intervalMs = params.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl()}/v1beta/${params.name}?key=${params.apiKey}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      throw new GeminiError(`file status check failed (${res.status})`, res.status, await readBody(res));
    }
    const file = (await res.json()) as GeminiFile;
    const state = file.state || "UNKNOWN";
    params.onTick?.(state);
    if (state === "ACTIVE") return;
    if (state === "FAILED") {
      throw new GeminiError("video processing failed on Gemini's side", res.status, JSON.stringify(file));
    }
    if (Date.now() > deadline) {
      throw new GeminiError(`timed out waiting for video to become ACTIVE (last state: ${state})`, 0, "");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A JSON-schema subset Gemini accepts in `responseSchema`. */
export type ResponseSchema = Record<string, unknown>;

/** gemini-2.5-flash output cap (per Google docs). gemini-2.5-pro is 65536
 *  too; older `-flash-001` was 8192. Setting this high is purely an upper
 *  bound — billed tokens are whatever the model actually emits. */
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/**
 * Run generateContent over an uploaded video with a structured JSON schema.
 * Returns the raw model text (expected to be a JSON document).
 *
 * Throws GeminiError on:
 *   - HTTP failure
 *   - promptFeedback.blockReason (safety block)
 *   - finishReason === 'MAX_TOKENS' (truncated output — surfaced explicitly
 *     so the operator sees the real cause instead of a downstream
 *     "Unterminated string in JSON" parse error)
 *   - finishReason ∈ { 'SAFETY', 'RECITATION', 'OTHER' } (model refused)
 *   - empty text
 */
export async function analyzeVideo(params: {
  apiKey: string;
  model: string;
  fileUri: string;
  mimeType: string;
  prompt: string;
  fps?: number;
  responseSchema: ResponseSchema;
  /** Override the default cap; mostly useful for tests. */
  maxOutputTokens?: number;
}): Promise<string> {
  const videoPart: Record<string, unknown> = {
    fileData: { mimeType: params.mimeType, fileUri: params.fileUri },
  };
  if (params.fps && params.fps > 0) {
    videoPart.videoMetadata = { fps: params.fps };
  }
  const res = await fetch(
    `${baseUrl()}/v1beta/models/${params.model}:generateContent?key=${params.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [videoPart, { text: params.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: params.responseSchema,
          temperature: 0.4,
          maxOutputTokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
      }),
    },
  );
  if (!res.ok) {
    throw new GeminiError(`generateContent failed (${res.status})`, res.status, await readBody(res));
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { candidatesTokenCount?: number; totalTokenCount?: number };
  };
  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(`request blocked: ${data.promptFeedback.blockReason}`, res.status, "");
  }
  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (finishReason === "MAX_TOKENS") {
    const out = data.usageMetadata?.candidatesTokenCount ?? "?";
    const cap = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    throw new GeminiError(
      `analysis truncated: Gemini hit the maxOutputTokens cap (${cap}; emitted ${out} tokens) — the video is too long or its segments too granular. Lower --fps (currently ${params.fps ?? "default"}), shorten the source, or raise the cap.`,
      res.status,
      text ? text.slice(0, 400) : "",
    );
  }
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new GeminiError(`analysis refused: finishReason=${finishReason}`, res.status, text.slice(0, 400));
  }
  if (!text) {
    throw new GeminiError("generateContent returned no text", res.status, JSON.stringify(data).slice(0, 800));
  }
  return text;
}

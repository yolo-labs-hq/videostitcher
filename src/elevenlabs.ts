/**
 * Minimal ElevenLabs REST client (Node 20 global fetch — no SDK dependency).
 * Covers exactly what the `voice` stage needs: list voices + text-to-speech.
 */

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category?: string;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

function baseUrl(): string {
  return process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL;
}

async function readError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** Resolve the API key from the explicit arg or VIDEOSTITCHER_ELEVENLABS_API_KEY. */
export function resolveApiKey(explicit?: string): string {
  const key = explicit || process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "no ElevenLabs API key — set VIDEOSTITCHER_ELEVENLABS_API_KEY (or pass --api-key)",
    );
  }
  return key;
}

export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const res = await fetch(`${baseUrl()}/v1/voices`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new ElevenLabsError(`list voices failed (${res.status})`, res.status, await readError(res));
  }
  const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string }> };
  return (data.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name, category: v.category }));
}

export interface TextToSpeechParams {
  apiKey: string;
  voiceId: string;
  text: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  /** Preceding/following narration for cross-segment prosody continuity. */
  previousText?: string;
  nextText?: string;
  /** ElevenLabs output format token, e.g. "mp3_44100_128". */
  outputFormat?: string;
}

/** Synthesize one narration clip; returns the raw audio bytes. */
export async function textToSpeech(params: TextToSpeechParams): Promise<Buffer> {
  const outputFormat = params.outputFormat ?? "mp3_44100_128";
  const url = `${baseUrl()}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}?output_format=${outputFormat}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": params.apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: params.text,
      model_id: params.modelId,
      voice_settings: {
        stability: params.stability,
        similarity_boost: params.similarityBoost,
      },
      ...(params.previousText ? { previous_text: params.previousText } : {}),
      ...(params.nextText ? { next_text: params.nextText } : {}),
    }),
  });
  if (!res.ok) {
    throw new ElevenLabsError(
      `text-to-speech failed (${res.status})`,
      res.status,
      await readError(res),
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new ElevenLabsError("text-to-speech returned empty audio", res.status, "");
  }
  return buf;
}

import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { FFMPEG_PATH } from "./ffmpeg.js";
import type { Timeline } from "./types.js";

/**
 * Auto-foley: turn a screencast take's `inputs.json` sidecar (written by the
 * browser-driver while recording — click/keypress timestamps, no content)
 * into an audio track of click and key sounds, remapped through the edit
 * timeline (trims, cuts, per-clip speed) so the sounds land where the
 * interaction is SEEN in the final video, not where it happened in the
 * source take.
 *
 * Two halves, both deliberately pure-ish and unit-testable:
 *   - `remapFoleyEvents` — source-time → output-time math (no I/O).
 *   - `renderFoleyWav` — synthesizes the track as PCM in-process (48 kHz
 *     mono s16 WAV). No sound assets required: clicks/key ticks are
 *     enveloped sine+noise bursts that read convincingly as UI sounds. A
 *     `samplesDir` with click/key/space/enter .wav files overrides the
 *     synthesis per-kind (decoded via the bundled ffmpeg).
 *
 * The track is mixed into the stitch as one extra audio-bus placement at
 * t=0 — the existing adelay/apad/amix graph handles it like any narration
 * clip. Foley is best-effort everywhere: a malformed sidecar or failed
 * render must never fail a stitch.
 */

// ── sidecar schema (browser-driver record.js writes this) ────────────────

export const FoleyInputEventSchema = z
  .object({
    type: z.enum(["click", "key"]),
    /** Epoch-ms, same clock as the take's frame timestamps. */
    ts: z.number(),
    /** Named special key (Enter/Tab/Space/…) — never typed content. */
    key: z.string().optional(),
    /** Multi-click count (double/triple click) — clicks only. */
    count: z.number().int().min(1).optional(),
  })
  .passthrough();
export type FoleyInputEvent = z.infer<typeof FoleyInputEventSchema>;

export const FoleySidecarSchema = z
  .object({
    version: z.number(),
    /** Epoch-ms of the take's first captured frame — the video's t=0. */
    firstFrameTs: z.number(),
    events: z.array(FoleyInputEventSchema).default([]),
  })
  .passthrough();
export type FoleySidecar = z.infer<typeof FoleySidecarSchema>;

/** Sidecar path convention: `<video minus ext>.inputs.json` next to the
 *  source file (the workspace import copies the take's `inputs.json` to
 *  this name). */
export function sidecarPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return (ext ? videoPath.slice(0, -ext.length) : videoPath) + ".inputs.json";
}

/** Find + parse the foley sidecar for every timeline source that has one.
 *  Returns a sourceId → sidecar map; sources without a (valid) sidecar are
 *  simply absent. Never throws. */
export async function loadFoleySidecars(
  timeline: Timeline,
  projectDir: string,
): Promise<Map<string, FoleySidecar>> {
  const map = new Map<string, FoleySidecar>();
  for (const src of timeline.sources) {
    const videoPath = path.isAbsolute(src.filePath)
      ? src.filePath
      : path.resolve(projectDir, src.filePath);
    try {
      const raw = JSON.parse(await fs.readFile(sidecarPathFor(videoPath), "utf8"));
      const parsed = FoleySidecarSchema.safeParse(raw);
      if (parsed.success && Number.isFinite(parsed.data.firstFrameTs)) {
        map.set(src.id, parsed.data);
      }
    } catch {
      /* no sidecar / unreadable — fine */
    }
  }
  return map;
}

// ── source-time → output-time remap ──────────────────────────────────────

export type FoleyKind = "click" | "key" | "key-space" | "key-enter";

export interface PlacedFoleyEvent {
  /** Output-timeline seconds where the sound starts. */
  atSec: number;
  kind: FoleyKind;
  /** Click repetitions (double/triple click). Always 1 for keys. */
  count: number;
}

/**
 * Map sidecar events onto the OUTPUT timeline. An event sounds once per
 * video clip whose trimmed source span contains it (a moment used twice in
 * the edit clicks twice — that's what the viewer sees); events trimmed out
 * of every clip are dropped. Within a clip:
 *
 *   outputSec = timelineStartSec + (srcSec − sourceInSec) / speed
 *
 * Speed only rescales the position — the tick itself plays at normal pitch
 * (a 4× build montage shouldn't sound like a chipmunk keyboard; sped-up
 * sections read better with normal-rate ticks at compressed spacing).
 *
 * Pure function: caller supplies the sidecars (see loadFoleySidecars).
 * Assumes planTimeline's invariants (single lane, back-to-back) have been
 * validated by the caller — stitch runs planTimeline first.
 */
export function remapFoleyEvents(
  timeline: Timeline,
  sidecars: Map<string, FoleySidecar>,
): PlacedFoleyEvent[] {
  const placed: PlacedFoleyEvent[] = [];
  for (const clip of timeline.video) {
    const sc = sidecars.get(clip.sourceId);
    if (!sc) continue;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    for (const ev of sc.events) {
      const srcSec = (ev.ts - sc.firstFrameTs) / 1000;
      if (srcSec < clip.sourceInSec || srcSec >= clip.sourceOutSec) continue;
      placed.push({
        atSec: clip.timelineStartSec + (srcSec - clip.sourceInSec) / speed,
        kind:
          ev.type === "click"
            ? "click"
            : ev.key === "Space"
              ? "key-space"
              : ev.key === "Enter"
                ? "key-enter"
                : "key",
        // Cap repeats — the sidecar caps clickCount upstream, but a
        // hand-edited file shouldn't be able to machine-gun the mix.
        count: ev.type === "click" ? Math.min(Math.max(ev.count ?? 1, 1), 3) : 1,
      });
    }
  }
  placed.sort((a, b) => a.atSec - b.atSec);
  return placed;
}

// ── PCM synthesis ─────────────────────────────────────────────────────────

export const FOLEY_SAMPLE_RATE = 48000;

/** Deterministic PRNG (mulberry32) so two renders of the same timeline are
 *  byte-identical — per-key pitch/level variation must not break the
 *  idempotent-stages contract. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TickSpec {
  durMs: number;
  /** Sine component frequency (Hz). */
  freq: number;
  /** 0..1 — noise fraction of the mix (1 = pure noise burst). */
  noise: number;
  /** Peak amplitude, 0..1. */
  amp: number;
  /** Exponential decay sharpness — higher dies faster. */
  decay: number;
}

/** Synthesize one enveloped sine+noise tick. `rand` drives the noise
 *  component (deterministic). */
function synthTick(spec: TickSpec, rand: () => number): Float32Array {
  const nSamp = Math.max(1, Math.round((FOLEY_SAMPLE_RATE * spec.durMs) / 1000));
  const out = new Float32Array(nSamp);
  let phase = 0;
  const step = (2 * Math.PI * spec.freq) / FOLEY_SAMPLE_RATE;
  for (let i = 0; i < nSamp; i++) {
    const t = i / nSamp;
    // Fast attack (first ~8% ramps in, avoids a DC pop), then decay.
    const attack = t < 0.08 ? t / 0.08 : 1;
    const env = attack * Math.exp(-spec.decay * t);
    phase += step;
    const s = Math.sin(phase) * (1 - spec.noise) + (rand() * 2 - 1) * spec.noise;
    out[i] = s * env * spec.amp;
  }
  return out;
}

/** Mouse click: a sharp "down" transient plus a softer "up" ~70ms later —
 *  the two-part shape is what reads as a real mouse instead of a beep. */
function synthClick(rand: () => number): Float32Array {
  const down = synthTick({ durMs: 14, freq: 1900, noise: 0.65, amp: 0.42, decay: 7 }, rand);
  const up = synthTick({ durMs: 10, freq: 2300, noise: 0.65, amp: 0.26, decay: 8 }, rand);
  const gapSamp = Math.round(FOLEY_SAMPLE_RATE * 0.07);
  const out = new Float32Array(gapSamp + up.length);
  out.set(down, 0);
  for (let i = 0; i < up.length; i++) out[gapSamp + i] += up[i];
  return out;
}

function synthKey(kind: FoleyKind, rand: () => number): Float32Array {
  // Per-event variation: ±15% pitch, 80–100% level — uniform ticks sound
  // mechanical, this reads as human typing.
  const pitch = 0.85 + rand() * 0.3;
  const level = 0.8 + rand() * 0.2;
  switch (kind) {
    case "key-space":
      // The spacebar thock: deeper and a touch louder than a letter key.
      return synthTick({ durMs: 12, freq: 750 * pitch, noise: 0.8, amp: 0.2 * level, decay: 6 }, rand);
    case "key-enter":
      // Enter: deeper still, slightly longer — the satisfying "done" thunk.
      return synthTick({ durMs: 20, freq: 600 * pitch, noise: 0.75, amp: 0.26 * level, decay: 5 }, rand);
    default:
      return synthTick({ durMs: 9, freq: 1100 * pitch, noise: 0.85, amp: 0.15 * level, decay: 7 }, rand);
  }
}

// ── optional custom samples ───────────────────────────────────────────────

const SAMPLE_FILES: Record<FoleyKind, string> = {
  click: "click.wav",
  key: "key.wav",
  "key-space": "space.wav",
  "key-enter": "enter.wav",
};
/** Cap a custom sample at 1s — foley ticks are transients; a long file is
 *  almost certainly a mistake and would smear the whole mix. */
const SAMPLE_MAX_SEC = 1;

/** Decode an audio file to 48 kHz mono float PCM via the bundled ffmpeg. */
async function decodeSampleToPcm(file: string): Promise<Float32Array> {
  const tmp = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "vs-foley-")),
    "sample.raw",
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, [
        "-y",
        "-i", file,
        "-t", String(SAMPLE_MAX_SEC),
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-ar", String(FOLEY_SAMPLE_RATE),
        "-ac", "1",
        tmp,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      proc.stderr.on("data", (d) => { err += String(d); });
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg decode failed (${code}): ${err.slice(-300)}`)));
    });
    const raw = await fs.readFile(tmp);
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
  }
}

/** Load whatever custom samples exist in `samplesDir` (click.wav / key.wav /
 *  space.wav / enter.wav). Kinds without a file fall back to synthesis. */
async function loadCustomSamples(
  samplesDir: string,
): Promise<Partial<Record<FoleyKind, Float32Array>>> {
  const loaded: Partial<Record<FoleyKind, Float32Array>> = {};
  for (const [kind, file] of Object.entries(SAMPLE_FILES) as Array<[FoleyKind, string]>) {
    const p = path.join(samplesDir, file);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) loaded[kind] = await decodeSampleToPcm(p);
    } catch {
      /* absent / undecodable — synth fallback */
    }
  }
  return loaded;
}

// ── track render ──────────────────────────────────────────────────────────

export interface RenderFoleyOptions {
  /** Track length (seconds) — clamped to this exactly, so the stitch's
   *  audio bus (apad/atrim to finalDurationSec) sees a well-behaved file. */
  totalDurationSec: number;
  /** Directory with custom click/key/space/enter .wav overrides. */
  samplesDir?: string;
  /** Linear gain applied to the whole track (timeline.foley.volume). */
  volume?: number;
}

export interface RenderFoleyResult {
  outPath: string;
  durationSec: number;
  eventCount: number;
}

/** Render placed events into a 48 kHz mono s16 WAV at `outPath`. */
export async function renderFoleyWav(
  events: PlacedFoleyEvent[],
  outPath: string,
  opts: RenderFoleyOptions,
): Promise<RenderFoleyResult> {
  const durationSec = Math.max(0.001, opts.totalDurationSec);
  const volume = Number.isFinite(opts.volume) && (opts.volume as number) >= 0 ? (opts.volume as number) : 1;
  const totalSamples = Math.ceil(durationSec * FOLEY_SAMPLE_RATE);
  const mix = new Float32Array(totalSamples);

  let custom: Partial<Record<FoleyKind, Float32Array>> = {};
  if (opts.samplesDir) {
    try {
      custom = await loadCustomSamples(opts.samplesDir);
    } catch {
      /* synth fallback */
    }
  }

  // Double/triple-click repeat cadence.
  const MULTI_CLICK_GAP_SEC = 0.12;

  events.forEach((ev, i) => {
    const rand = mulberry32(0x5eed + i * 7919);
    for (let rep = 0; rep < ev.count; rep++) {
      const at = ev.atSec + rep * MULTI_CLICK_GAP_SEC;
      const startSamp = Math.round(at * FOLEY_SAMPLE_RATE);
      if (startSamp >= totalSamples) continue;
      let pcm = custom[ev.kind];
      if (pcm) {
        // Custom sample: vary level only (deterministic), keep pitch.
        const level = (0.85 + rand() * 0.15) * volume;
        for (let s = 0; s < pcm.length && startSamp + s < totalSamples; s++) {
          mix[startSamp + s] += pcm[s] * level;
        }
      } else {
        const tick = ev.kind === "click" ? synthClick(rand) : synthKey(ev.kind, rand);
        for (let s = 0; s < tick.length && startSamp + s < totalSamples; s++) {
          mix[startSamp + s] += tick[s] * volume;
        }
      }
    }
  });

  // Soft-clip into s16. Plain clamp is fine here — events rarely overlap
  // and the synth peaks well under 1.0 even when a click and key collide.
  const data = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const v = Math.max(-1, Math.min(1, mix[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }

  // Minimal RIFF/WAVE header — PCM s16le mono.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(FOLEY_SAMPLE_RATE, 24);
  header.writeUInt32LE(FOLEY_SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.concat([header, data]));
  return { outPath, durationSec, eventCount: events.length };
}

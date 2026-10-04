import { promises as fs } from "node:fs";
import path from "node:path";
import type { NarrationClip, Timeline } from "../types.js";
import { FILES, ensureDir, loadTimeline, projectPath, saveTimeline } from "../project.js";
import { probeDuration } from "../ffmpeg.js";
import {
  ElevenLabsError,
  resolveApiKey,
  textToSpeech,
  type TextToSpeechParams,
} from "../elevenlabs.js";
import { confirm } from "../prompt.js";
import { narrationHash } from "../narrationHash.js";
import { fail, info, ok, step, warn } from "../log.js";

export interface VoiceCommandOptions {
  voice?: string;
  apiKey?: string;
  modelId?: string;
  outputFormat?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** Force re-render of clips that already have rendered audio. Without this
   *  flag, green clips whose narrationHash still matches the current text
   *  are skipped (the same "reuse existing" semantics the legacy command had). */
  force?: boolean;
  /** Restrict the run to a specific set of narration ids. Default = all.
   *  Surfaces as `videostitcher voice --ids nar-001,nar-007` and is what the
   *  UI's "render selected" / "render unrendered" buttons will use via the
   *  HTTP equivalent. */
  ids?: string[];
}

interface PlannedClip {
  narration: NarrationClip;
  rel: string;
  abs: string;
  previousText?: string;
  nextText?: string;
  /** True iff there's already a matching rendered file on disk and the
   *  hash matches the current narration text. */
  reusable: boolean;
}

export async function voiceCommand(projectDir: string, opts: VoiceCommandOptions): Promise<Timeline> {
  const timeline = await loadTimeline(projectDir);
  const voiceId = opts.voice || timeline.voice.voiceId;
  if (!voiceId) {
    throw new Error(
      "no voice selected — run `videostitcher voices` to list voices, then set voice.voiceId in timeline.json or pass --voice <id>",
    );
  }
  const modelId = opts.modelId || timeline.voice.modelId;
  const audioDir = projectPath(projectDir, FILES.audioDir);
  await ensureDir(audioDir);

  // ── select clips to render ──
  // Filter to narration with text + an id match (if --ids given). Empty
  // narration is silent in stitch, so there's nothing to synthesize.
  const idFilter = opts.ids?.length ? new Set(opts.ids) : null;
  const candidates = timeline.narration.filter((n) => {
    if (idFilter && !idFilter.has(n.id)) return false;
    // UPLOADED audio (music bed / pre-recorded VO) is authoritative — never
    // TTS-synthesize over it, even if the operator added caption text to it.
    if (n.audio?.source === "upload") return false;
    return n.narration.trim().length > 0;
  });

  const plan: PlannedClip[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i]!;
    const rel = path.join(FILES.audioDir, `${n.id}.mp3`);
    const abs = path.resolve(projectDir, rel);
    const fileExists = await statSize(abs) > 0;
    const currentHash = narrationHash(n.narration);
    const hashMatches = n.audio?.narrationHash === currentHash;
    const reusable = !opts.force && fileExists && n.audio != null && hashMatches;
    plan.push({
      narration: n,
      rel,
      abs,
      previousText: candidates[i - 1]?.narration,
      nextText: candidates[i + 1]?.narration,
      reusable,
    });
  }

  if (plan.length === 0) {
    warn("no narration clips to render (no text, or id filter matched nothing)");
    return timeline;
  }

  // ── cost guard ──
  const toGenerate = plan.filter((p) => !p.reusable);
  const reused = plan.length - toGenerate.length;
  const charsToBill = toGenerate.reduce((sum, p) => sum + p.narration.narration.trim().length, 0);

  step(`Rendering narration in "${path.basename(projectDir)}" — voice ${voiceId}, model ${modelId}`);
  info(`  narration clips    : ${plan.length}`);
  if (reused > 0) info(`  reused (hash match): ${reused}  (pass --force to regenerate)`);
  info(`  to synthesize      : ${toGenerate.length}`);
  info(`  characters billed  : ≈ ${charsToBill.toLocaleString()}  (ElevenLabs bills per character)`);

  if (opts.dryRun) {
    ok("dry run — no API calls made, timeline.json left untouched");
    return timeline;
  }
  if (charsToBill === 0) {
    ok("all clips already rendered with matching hash — nothing to do");
    return timeline;
  }
  if (!opts.yes) {
    const proceed = await confirm(`Send ≈ ${charsToBill.toLocaleString()} characters to ElevenLabs?`);
    if (!proceed) {
      fail("aborted by user");
      throw new Error("voice generation aborted");
    }
  }

  // ── synthesize sequentially (rate-limit friendly, deterministic logs) ──
  const apiKey = resolveApiKey(opts.apiKey);
  for (const p of plan) {
    if (p.reusable) {
      ok(`${p.narration.id}: reused existing clip`);
      continue;
    }
    const params: TextToSpeechParams = {
      apiKey,
      voiceId,
      text: p.narration.narration.trim(),
      modelId,
      stability: timeline.voice.stability,
      similarityBoost: timeline.voice.similarityBoost,
      previousText: p.previousText,
      nextText: p.nextText,
      outputFormat: opts.outputFormat,
    };
    try {
      const audio = await textToSpeech(params);
      await fs.writeFile(p.abs, audio);
      const dur = await probeDuration(p.abs);
      ok(`${p.narration.id}: ${p.narration.narration.trim().length} chars → ${dur.toFixed(2)}s`);
    } catch (err) {
      if (err instanceof ElevenLabsError) {
        fail(`${p.narration.id}: ${err.message}${err.body ? ` — ${err.body}` : ""}`);
      }
      throw err;
    }
  }

  // ── update narration[].audio in place ──
  return writeRenderedAudioInto(projectDir, timeline, plan);
}

async function statSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

async function writeRenderedAudioInto(
  projectDir: string,
  timeline: Timeline,
  plan: PlannedClip[],
): Promise<Timeline> {
  // Build a {id → freshly-probed audio metadata} map from disk so the
  // manifest reflects what's actually rendered (including reused clips that
  // already had matching files).
  const audioById = new Map<string, NarrationClip["audio"]>();
  for (const p of plan) {
    try {
      const durationSec = await probeDuration(p.abs);
      audioById.set(p.narration.id, {
        path: p.rel,
        durationSec,
        renderedAt: new Date().toISOString(),
        narrationHash: narrationHash(p.narration.narration),
        source: "tts",
      });
    } catch {
      warn(`${p.narration.id}: no clip on disk — leaving narration red`);
      audioById.set(p.narration.id, null);
    }
  }
  // Patch the timeline: every clip we touched picks up its new audio (or
  // null if it failed); clips we didn't touch keep whatever they had.
  const next: Timeline = {
    ...timeline,
    narration: timeline.narration.map((n) => {
      if (!audioById.has(n.id)) return n;
      return { ...n, audio: audioById.get(n.id) ?? null };
    }),
  };
  await saveTimeline(projectDir, next);
  ok(`updated ${FILES.timeline} (${next.narration.filter((n) => n.audio).length}/${next.narration.length} clip(s) rendered)`);
  return next;
}

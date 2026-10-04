import path from "node:path";
import type { NarrationClip, Timeline } from "../types.js";
import { FILES, ensureDir, loadTimeline, projectPath, saveTimeline } from "../project.js";
import { runFfmpeg } from "../ffmpeg.js";
import { ESTIMATE_MIN_SEC, ESTIMATE_WORDS_PER_SEC, narrationHash } from "../narrationHash.js";
import { ok, step, warn } from "../log.js";

export interface MockVoiceOptions {
  /** Spoken pace used to estimate clip length from word count. */
  wordsPerSec?: number;
  /** Floor so very short lines still produce an audible-length clip. */
  minSec?: number;
  /** Restrict the run to a specific set of narration ids (mirrors voice.ts). */
  ids?: string[];
}

/**
 * Offline stand-in for the ElevenLabs `voice` stage. Renders a silent audio
 * clip of the estimated narration length for each clip and stamps it into
 * the timeline's narration[].audio, so the operator can exercise the
 * unified-timeline editor + stitch graph without spending API budget.
 */
export async function mockVoiceCommand(projectDir: string, opts: MockVoiceOptions): Promise<Timeline> {
  const wps = opts.wordsPerSec ?? ESTIMATE_WORDS_PER_SEC;
  const minSec = opts.minSec ?? ESTIMATE_MIN_SEC;
  const timeline = await loadTimeline(projectDir);
  const audioDir = projectPath(projectDir, FILES.audioDir);
  await ensureDir(audioDir);

  const idFilter = opts.ids?.length ? new Set(opts.ids) : null;
  const candidates = timeline.narration.filter((n) => {
    if (idFilter && !idFilter.has(n.id)) return false;
    // Never overwrite uploaded audio with a silent mock placeholder.
    if (n.audio?.source === "upload") return false;
    return n.narration.trim().length > 0;
  });

  step(`Generating mock narration for ${candidates.length} clip(s) @ ${wps} words/s`);
  const renderedById = new Map<string, NarrationClip["audio"]>();
  for (const n of candidates) {
    const words = n.narration.trim().split(/\s+/).filter(Boolean).length;
    if (words === 0) {
      warn(`${n.id}: empty narration — skipping (stays red)`);
      continue;
    }
    const durationSec = Math.max(minSec, words / wps);
    const rel = path.join(FILES.audioDir, `${n.id}.wav`);
    const abs = path.resolve(projectDir, rel);
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
      "-t", durationSec.toFixed(3),
      "-c:a", "pcm_s16le",
      abs,
    ]);
    renderedById.set(n.id, {
      path: rel,
      durationSec,
      renderedAt: new Date().toISOString(),
      narrationHash: narrationHash(n.narration),
      source: "mock",
    });
    ok(`${n.id}: ${words} words → ${durationSec.toFixed(2)}s`);
  }

  const next: Timeline = {
    ...timeline,
    narration: timeline.narration.map((n) =>
      renderedById.has(n.id) ? { ...n, audio: renderedById.get(n.id) ?? null } : n,
    ),
  };
  await saveTimeline(projectDir, next);
  ok(`updated ${FILES.timeline} (${next.narration.filter((n) => n.audio).length}/${next.narration.length} clip(s) rendered)`);
  return next;
}

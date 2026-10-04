import {
  TIMELINE_SCHEMA_VERSION,
  TimelineSchema,
  type Analysis,
  type NarrationClip,
  type Project,
  type Timeline,
  type VoiceConfig,
} from "./types.js";
import { estimateNarrationDurationSec } from "./narrationHash.js";
import type { ScriptDraft } from "./claude.js";

const DEFAULT_VOICE: VoiceConfig = {
  modelId: "eleven_turbo_v2_5",
  stability: 0.5,
  similarityBoost: 0.75,
};

/**
 * Build a fresh Timeline from a Gemini analysis + Claude narration draft.
 *
 * Wraps the single source video as one VideoSource + one VideoClip covering
 * its full duration (the operator can later trim or add sources via the
 * video-track UI). Each analysis segment becomes one NarrationClip anchored
 * at the segment's startSec — the segment endSec is intentionally dropped:
 * the new model has no segment window, audio plays at its startSec for its
 * own duration. All narration entries start RED (audio: null); the operator
 * triggers `render` to populate audio.
 *
 * Returns the timeline plus any ids Claude missed or invented.
 */
export function buildTimelineFromAnalysis(
  project: Project,
  analysis: Analysis,
  draft: ScriptDraft,
  voice: VoiceConfig = DEFAULT_VOICE,
): { timeline: Timeline; missing: string[]; extra: string[] } {
  const byId = new Map(draft.segments.map((s) => [s.id, s]));
  const analysisIds = new Set(analysis.segments.map((s) => s.id));
  const missing: string[] = [];

  const narration: NarrationClip[] = analysis.segments.map((a) => {
    const d = byId.get(a.id);
    if (!d) missing.push(a.id);
    const text = (d?.narration ?? "").trim();
    return {
      id: a.id,
      startSec: a.startSec,
      narration: text,
      pauseAfterSec: Math.max(0, d?.pauseAfterSec ?? 0),
      estDurationSec: estimateNarrationDurationSec(text),
      audio: null,
    };
  });

  const extra = draft.segments.filter((s) => !analysisIds.has(s.id)).map((s) => s.id);

  const sourceId = "src-001";
  const timeline = TimelineSchema.parse({
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    durationSec: analysis.durationSec,
    voice,
    sources: [{ id: sourceId, filePath: project.videoPath, displayName: project.name }],
    video: [{
      id: "vid-001",
      sourceId,
      sourceInSec: 0,
      sourceOutSec: analysis.durationSec,
      timelineStartSec: 0,
    }],
    narration,
  });

  return { timeline, missing, extra };
}

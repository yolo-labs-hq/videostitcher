import { z } from "zod";

/**
 * Artifact schemas for the videostitcher pipeline.
 *
 * The pipeline is a chain of idempotent stages, each reading the previous
 * stage's artifact and writing its own into the project directory:
 *
 *   project.json  (init)
 *   analysis.json (analyze — Gemini)   [Phase 3]
 *   script.json   (script  — Claude)   [Phase 4]  ← human-editable handoff
 *   voice.json    (voice   — 11Labs)   [Phase 2]
 *   out/final.mp4 (stitch  — ffmpeg)   [Phase 1, here]
 *
 * Only project/script/voice are consumed by the stitch stage. analysis is
 * defined here for forward-compatibility so the schema lives in one place.
 */

export const SCHEMA_VERSION = 1;

/** A timed slice of the source video. The startSec/endSec anchor narration to
 *  the original footage and survive every stage unchanged. */
export const SegmentSchema = z.object({
  id: z.string(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});
export type Segment = z.infer<typeof SegmentSchema>;

// ── analyze (Gemini) ────────────────────────────────────────────────────────
export const AnalysisSegmentSchema = SegmentSchema.extend({
  transition: z.string().optional(),
  visualSummary: z.string().optional(),
  onScreenText: z.array(z.string()).optional(),
  keyAction: z.string().optional(),
  suggestedBeat: z.string().optional(),
});
export type AnalysisSegment = z.infer<typeof AnalysisSegmentSchema>;

export const AnalysisSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  durationSec: z.number().positive(),
  fps: z.number().positive().optional(),
  brief: z.string().optional(),
  segments: z.array(AnalysisSegmentSchema).min(1),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ── voice config (shared by Timeline.voice) ─────────────────────────────────
export const VoiceConfigSchema = z.object({
  voiceId: z.string().optional(),
  modelId: z.string().default("eleven_turbo_v2_5"),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

// ── project ──────────────────────────────────────────────────────────────────
export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  name: z.string(),
  /** Absolute path to the source video. */
  videoPath: z.string(),
  brief: z.string().default(""),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ── timeline (Phase 1+, replaces script + voice) ─────────────────────────────
// Unified per-project artifact: one audio "narration" track + one video
// "sources/clips" model. Audio and video are fully independent (no segment
// window constraint). See docs/UNIFIED_TIMELINE_PLAN.md.

/** Schema version for the unified timeline. Distinct from SCHEMA_VERSION so
 *  the legacy script.json / voice.json pair (v1) and the new timeline.json
 *  (v2) can be told apart trivially during migration. */
export const TIMELINE_SCHEMA_VERSION = 2;

/** A single source video file referenced by one or more video clips. Phase 1
 *  always has exactly one source; Phase 2 lets the operator add more. */
export const VideoSourceSchema = z.object({
  id: z.string(),
  /** Path relative to the project dir, or absolute. */
  filePath: z.string(),
  displayName: z.string().default(""),
  /** Probed via ffprobe at upload time; advisory (stitch re-probes). */
  durationSec: z.number().positive().optional(),
});
export type VideoSource = z.infer<typeof VideoSourceSchema>;

/** A trimmed slice of a source video laid onto the final timeline. Clips
 *  MUST be ordered by timelineStartSec and MUST NOT overlap (cut-only). */
export const VideoClipSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceInSec: z.number().min(0),
  sourceOutSec: z.number().min(0),
  timelineStartSec: z.number().min(0),
  /** Playback-rate multiplier for this clip: >1 speeds it up, <1 slows it
   *  down. The EFFECTIVE on-timeline (played) duration is
   *  (sourceOutSec − sourceInSec) / speed — speed changes how long the trimmed
   *  slice occupies the output, the trim points stay in source seconds.
   *  OPTIONAL: absent ⇒ 1× (no change). Consumers (timing/stitch/UI) all
   *  default a missing/invalid value to 1, so legacy timelines and untouched
   *  clips are byte-for-byte unaffected and 1× clips need not persist it. */
  speed: z.number().min(0.25).max(4).optional(),
  /** Lane (track) index this clip lives on: 0 = bottom, higher = upper/front
   *  (z-order — a higher lane's clip is shown on top where lanes overlap in
   *  time). Within a lane clips stay cut-only & back-to-back; different lanes
   *  may overlap in time (layering). OPTIONAL: absent ⇒ lane 0, so legacy
   *  single-track timelines are unchanged. */
  track: z.number().int().min(0).optional(),
});
export type VideoClip = z.infer<typeof VideoClipSchema>;

/** Audio rendered by the `render` stage (ElevenLabs or mock). Absent ⇒ the
 *  narration is still in draft form (red on the timeline). Present ⇒ rendered
 *  (green). narrationHash is the hash of the narration text at render time;
 *  when the current text differs, the UI treats the clip as red even though
 *  the file still exists on disk, forcing a re-render. */
export const RenderedAudioSchema = z.object({
  path: z.string(),
  durationSec: z.number().min(0),
  renderedAt: z.string().optional(),
  narrationHash: z.string().optional(),
  /** Where this audio came from. `tts` = ElevenLabs render, `mock` = the
   *  silent anullsrc placeholder, `upload` = an operator-supplied mp3/wav
   *  (music bed / pre-recorded VO). Replaces the legacy ".wav ⇒ mock"
   *  filename heuristic — an uploaded .wav must NOT be flagged a silent
   *  placeholder. OPTIONAL: absent ⇒ fall back to the extension heuristic so
   *  pre-existing timelines are unchanged. */
  source: z.enum(["tts", "mock", "upload"]).optional(),
});
export type RenderedAudio = z.infer<typeof RenderedAudioSchema>;

/** A single line of narration on the audio track. Lives anywhere on the
 *  timeline at startSec; estDurationSec is the words/pace estimate used for
 *  visual width while red, and is ignored once `audio` is populated. */
export const NarrationClipSchema = z.object({
  id: z.string(),
  startSec: z.number().min(0),
  narration: z.string().default(""),
  pauseAfterSec: z.number().min(0).default(0),
  estDurationSec: z.number().min(0).default(0),
  audio: RenderedAudioSchema.nullable().default(null),
  // Trim points into the rendered audio (seconds). Absent ⇒ play the full
  // audio (0..durationSec). audioInSec skips into the start; audioOutSec
  // cuts the end short (or, if dragged past the real audio duration, pads
  // trailing silence). Only meaningful once `audio` is populated.
  audioInSec: z.number().min(0).optional(),
  audioOutSec: z.number().min(0).optional(),
  // Lane (track) index this voiceover lives on: 0 = first/top lane, higher =
  // lanes added below. Lanes let the operator separate voiceover from a
  // music/ambience bed, and clips on different lanes may overlap in time. Each
  // lane carries its own volume/mute mix settings (see Timeline.audioLanes),
  // applied to every clip on the lane in BOTH preview and the final stitch.
  // OPTIONAL: absent ⇒ lane 0, so legacy single-track timelines are
  // byte-for-byte unchanged.
  track: z.number().int().min(0).optional(),
});
export type NarrationClip = z.infer<typeof NarrationClipSchema>;

/** Project-level caption settings (Slice 1). When `enabled`, every
 *  narration clip's text is burned into the final stitch as an on-screen
 *  caption, timed to the narration's startSec for its duration. Style is
 *  fixed for now (bottom-center, white text on translucent black box,
 *  ~24px) — a future slice can plumb position/font/color through the UI. */
export const CaptionConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type CaptionConfig = z.infer<typeof CaptionConfigSchema>;

/** Auto-foley settings. When a source video has an `inputs.json` sidecar
 *  (screencast takes record click/keypress timestamps), the stitch mixes
 *  synthesized click/key sounds at the remapped output times. Default ON —
 *  it only fires when sidecar data exists, so non-take projects are
 *  unaffected. `volume` is a linear gain on the foley track. */
export const FoleyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  volume: z.number().min(0).max(2).default(1),
});
export type FoleyConfig = z.infer<typeof FoleyConfigSchema>;

// ── text overlays (Slice 2) ──────────────────────────────────────────────
// Freeform on-screen text blocks: title cards, lower thirds, callouts.
// Each lives on the timeline at its own startSec for its durationSec
// (independent of narration). Position is a 3×3 grid (vertical ×
// horizontal) — enough variety for typical screencast titling without
// the complexity of pixel-positioning that would break across video
// resolutions. Style is fontSize + color + boxColor (translucent
// allowed via rgba()).

export const TextOverlayPositionSchema = z.object({
  vertical: z.enum(["top", "middle", "bottom"]).default("bottom"),
  horizontal: z.enum(["left", "center", "right"]).default("center"),
});
export type TextOverlayPosition = z.infer<typeof TextOverlayPositionSchema>;

export const TextOverlayStyleSchema = z.object({
  fontSize: z.number().min(8).max(200).default(36),
  color: z.string().default("white"),
  /** Box background; accepts CSS rgba()/named colors. Empty string = no
   *  box (text-shadow only). */
  boxColor: z.string().default("rgba(0,0,0,0.55)"),
});
export type TextOverlayStyle = z.infer<typeof TextOverlayStyleSchema>;

export const TextOverlaySchema = z.object({
  id: z.string(),
  startSec: z.number().min(0),
  /** How long the overlay stays on screen. Operator-editable (vs.
   *  narration clips where duration is locked to audio file length). */
  durationSec: z.number().positive(),
  text: z.string().default(""),
  position: TextOverlayPositionSchema.default({ vertical: "bottom", horizontal: "center" }),
  style: TextOverlayStyleSchema.default({ fontSize: 36, color: "white", boxColor: "rgba(0,0,0,0.55)" }),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

/** Per-voiceover-lane mix settings. A lane's `volume` is a linear gain applied
 *  to every narration clip on that lane (0 = silent, 1 = unchanged, up to 2 ≈
 *  +6 dB); `muted` drops the lane from the mix entirely (independent of volume,
 *  so un-muting restores the prior gain). Applied in BOTH the live preview and
 *  the final stitch. */
export const AudioLaneSchema = z.object({
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
});
export type AudioLane = z.infer<typeof AudioLaneSchema>;

export const TimelineSchema = z.object({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSION).default(TIMELINE_SCHEMA_VERSION),
  /** Total timeline duration. Derived from max(video clip end, narration
   *  end + duration) — persisted so consumers don't have to recompute. */
  durationSec: z.number().positive(),
  voice: VoiceConfigSchema.default({
    modelId: "eleven_turbo_v2_5",
    stability: 0.5,
    similarityBoost: 0.75,
  }),
  /** Caption settings — additive default `{ enabled: false }`. Pre-Slice-1
   *  timelines parse cleanly because the field is omitted by default. */
  captions: CaptionConfigSchema.default({ enabled: false }),
  /** Auto-foley settings — additive default; pre-foley timelines parse
   *  cleanly. Only takes effect when a source has an inputs.json sidecar. */
  foley: FoleyConfigSchema.default({ enabled: true, volume: 1 }),
  /** Freeform text overlays (Slice 2). Independent of narration —
   *  drop in title cards, lower thirds, callouts at arbitrary
   *  positions and times. Empty by default. */
  textOverlays: z.array(TextOverlaySchema).default([]),
  sources: z.array(VideoSourceSchema).min(1),
  video: z.array(VideoClipSchema).min(1),
  narration: z.array(NarrationClipSchema),
  /** How many video lanes the editor shows. OPTIONAL — the editor also
   *  derives a floor from the clips (max track + 1) and a minimum of 3, so
   *  absent ⇒ "min 3 lanes". Persisted so user-added empty lanes survive a
   *  reload. */
  laneCount: z.number().int().min(1).optional(),
  /** How many voiceover (audio) lanes the editor shows. OPTIONAL — the editor
   *  derives a floor from the narration clips (max track + 1) and a minimum of
   *  1, so absent ⇒ "min 1 lane" and legacy single-track projects look
   *  unchanged. Persisted so user-added empty voiceover lanes survive a
   *  reload. */
  audioLaneCount: z.number().int().min(1).optional(),
  /** Per-voiceover-lane mix settings, indexed positionally by lane
   *  (audioLanes[i] = lane i). OPTIONAL — short/sparse arrays are fine and a
   *  lane with no entry uses { volume: 1, muted: false }. Absent ⇒ every lane
   *  unchanged, so legacy timelines mix byte-for-byte the same. */
  audioLanes: z.array(AudioLaneSchema).optional(),
});
export type Timeline = z.infer<typeof TimelineSchema>;

/** Resolve a voiceover lane's effective mix settings, applying defaults for an
 *  absent entry. Shared by the planner (stitch) and — mirrored — the editor
 *  preview so the two never disagree on what a lane's gain/mute is. */
export function resolveAudioLane(
  timeline: Pick<Timeline, "audioLanes">,
  lane: number,
): { volume: number; muted: boolean } {
  const idx = Number.isFinite(lane) && lane > 0 ? Math.floor(lane) : 0;
  const cfg = timeline.audioLanes?.[idx];
  if (!cfg) return { volume: 1, muted: false };
  const volume = Number.isFinite(cfg.volume) ? Math.max(0, Math.min(2, cfg.volume)) : 1;
  return { volume, muted: cfg.muted === true };
}

import path from "node:path";
import type { NarrationClip, TextOverlay, Timeline, VideoClip, VideoSource } from "./types.js";
import { resolveAudioLane } from "./types.js";

/** A small epsilon to ignore sub-frame/sample rounding noise. */
const EPS = 1e-3;

// ── Plan types ────────────────────────────────────────────────────────────
// The plan is what `stitch.ts` consumes verbatim. All timing math lives
// here, none in the ffmpeg builder. The plan is intentionally narrower
// than Timeline so the ffmpeg side doesn't have to know about source
// lookups or narration text — it just sees "trim this absolute path
// here", "drop this audio file at Ns".

/** One source-video slice laid onto the output timeline, back-to-back
 *  with its neighbours (no overlap, no gaps — `cut-only` for Phase 1.2). */
export interface VideoSegmentPlan {
  id: string;
  /** Absolute source-file path (already resolved against the project dir). */
  sourcePath: string;
  sourceInSec: number;
  sourceOutSec: number;
  /** Playback-rate multiplier (1 = unchanged). The on-timeline (played)
   *  duration is (sourceOutSec − sourceInSec) / speed; stitch applies it as a
   *  setpts time-scale on the trimmed slice. */
  speed: number;
}

/** One rendered narration clip placed on the audio bus at `startSec`. */
export interface AudioPlacementPlan {
  id: string;
  /** Absolute audio-file path. */
  audioPath: string;
  /** Where the clip starts on the output timeline (seconds). */
  startSec: number;
  /** Played duration on the timeline (seconds) = the trimmed slice length
   *  (sourceOutSec − sourceInSec), or the full audio when untrimmed. */
  durationSec: number;
  /** In-point into the source audio file (seconds). 0 when untrimmed. */
  sourceInSec: number;
  /** Out-point into the source audio file (seconds). May exceed the real
   *  audio duration — stitch pads the tail with silence. Equals the real
   *  audio duration when untrimmed. */
  sourceOutSec: number;
  /** Real audio-file duration (ffprobed at render time). Lets stitch tell
   *  "trim within the audio" from "extend past it" (silence pad). */
  audioFileDurationSec: number;
  /** Linear gain to apply to this placement on the bus (from the clip's
   *  voiceover-lane volume). 1 = unchanged. Muted lanes never reach the plan
   *  (their clips are dropped in planTimeline), so this is always > 0. */
  gain: number;
}

/** One caption overlay rendered onto the video stream (Slice 1). The
 *  stitch step writes the text to a sibling file and references it via
 *  ffmpeg `drawtext textfile=…` to dodge the filter-graph escaping
 *  trap (commas, colons, single quotes, percent signs all collide). */
export interface CaptionPlan {
  id: string;
  text: string;
  /** Where the caption appears on the timeline (seconds). */
  startSec: number;
  /** How long it stays on screen (matches the audio duration when
   *  rendered, the estimate otherwise — so a caption is visible whether
   *  or not the clip has been rendered yet). */
  durationSec: number;
}

/** One freeform text overlay (Slice 2). Same drawtext mechanism as
 *  captions (textfile + enable=between), but with operator-controlled
 *  position + style. Captions and overlays share the same drawtext
 *  chain in the filter graph — they're functionally the same primitive
 *  with different defaults. */
export interface TextOverlayPlan {
  id: string;
  text: string;
  startSec: number;
  durationSec: number;
  /** Position bucket from the 3×3 grid. Converted to drawtext x= / y=
   *  expressions in stitch.ts. */
  vertical: "top" | "middle" | "bottom";
  horizontal: "left" | "center" | "right";
  /** Style knobs. fontSize is points (drawtext fontsize=); color is
   *  any CSS-style color name / hex / rgba(); boxColor empty string
   *  ⇒ no box. */
  fontSize: number;
  color: string;
  boxColor: string;
}

export interface TimelinePlan {
  video: VideoSegmentPlan[];
  audio: AudioPlacementPlan[];
  /** Captions to burn into the video stream. Empty when
   *  `timeline.captions.enabled` is false. */
  captions: CaptionPlan[];
  /** Freeform text overlays. Independent of captions; both flow into
   *  the same drawtext chain in stitch. */
  textOverlays: TextOverlayPlan[];
  /** Sum of all video clip windows — the natural "footage runtime". */
  videoTotalSec: number;
  /** max(videoTotalSec, lastAudioEnd) — what the final mp4 will be. */
  finalDurationSec: number;
  /** finalDurationSec − videoTotalSec; > 0 when audio runs past video. */
  freezeExtendSec: number;
}

// ── Planner ───────────────────────────────────────────────────────────────

/**
 * Build the output plan from a Timeline.
 *
 * Audio model: each NarrationClip with `audio` populated plays at its
 * `startSec` for its real `audio.durationSec`. No tempo fit, no segment
 * window — the operator's chosen position is honoured verbatim. Audio
 * clips MAY overlap (amix sums them) and MAY extend past the end of the
 * video (the final frame freeze-extends to cover the tail per the
 * `Extend with last video frame` decision in UNIFIED_TIMELINE_PLAN.md).
 *
 * Video model: clips in `video[]` are concatenated back-to-back, each
 * trimmed to `[sourceInSec, sourceOutSec]`. `timelineStartSec` MUST
 * match the cumulative length of prior clips (gap-free, no overlap).
 * Phase 1.2 always sees a single clip covering 0..durationSec from the
 * single source. Phase 2.x can introduce multiple clips and operators
 * dragging trims around; the same planner handles both.
 *
 * Throws on invariant violations (unknown sourceId, non-positive video
 * span, overlapping or gapped video clips) so failures surface before
 * ffmpeg gets confused mid-render.
 */
export function planTimeline(timeline: Timeline, projectDir: string): TimelinePlan {
  const srcById = new Map<string, VideoSource>(timeline.sources.map((s) => [s.id, s]));

  // ── video ──
  // Clips are grouped by LANE (track). Within a lane they're cut-only &
  // back-to-back; different lanes may overlap in time (layering). Rendering
  // overlapping lanes needs a compositing filtergraph that doesn't exist yet,
  // so for now only ONE lane may carry content at export time — multi-lane is
  // preview-only. Single-lane (all track 0 / absent) is byte-for-byte the
  // prior behaviour, so the existing concat graph + its tests are unchanged.
  const trackOf = (c: VideoClip): number =>
    typeof c.track === "number" && c.track > 0 ? Math.floor(c.track) : 0;
  const lanes = new Map<number, VideoClip[]>();
  for (const clip of timeline.video) {
    const t = trackOf(clip);
    if (!lanes.has(t)) lanes.set(t, []);
    lanes.get(t)!.push(clip);
  }
  if ([...lanes.values()].filter((l) => l.length > 0).length > 1) {
    const err = new Error(
      "Multi-lane layering can't be exported yet — it's preview-only. " +
        "Move all clips onto a single lane to render the final video.",
    ) as Error & { code?: string };
    err.code = "multi-track-render-not-yet";
    throw err;
  }

  const video: VideoSegmentPlan[] = [];
  let videoCursor = 0;
  for (const t of [...lanes.keys()].sort((a, b) => a - b)) {
    const laneClips = [...lanes.get(t)!].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    let cursor = 0; // OUTPUT seconds, back-to-back WITHIN this lane
    for (const clip of laneClips) {
      const src = srcById.get(clip.sourceId);
      if (!src) throw new Error(`video clip ${clip.id} references unknown source ${clip.sourceId}`);
      // rawSpan = trimmed source length; the non-positive check is on the trim.
      const rawSpan = clip.sourceOutSec - clip.sourceInSec;
      if (rawSpan <= EPS) {
        throw new Error(
          `video clip ${clip.id} has non-positive duration (${clip.sourceInSec} → ${clip.sourceOutSec})`,
        );
      }
      if (clip.sourceInSec < 0) {
        throw new Error(`video clip ${clip.id} has negative sourceInSec ${clip.sourceInSec}`);
      }
      // speed re-scales the trimmed slice's on-timeline footprint. The
      // back-to-back invariant + the running cursor are in OUTPUT (played)
      // seconds, so they use the effective span (rawSpan / speed), not rawSpan.
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const span = rawSpan / speed;
      if (Math.abs(clip.timelineStartSec - cursor) > EPS) {
        throw new Error(
          `video clip ${clip.id} expects timelineStartSec ${cursor} ` +
            `(back-to-back within lane ${t}), got ${clip.timelineStartSec}`,
        );
      }
      video.push({
        id: clip.id,
        sourcePath: path.isAbsolute(src.filePath)
          ? src.filePath
          : path.resolve(projectDir, src.filePath),
        sourceInSec: clip.sourceInSec,
        sourceOutSec: clip.sourceOutSec,
        speed,
      });
      cursor += span;
    }
    videoCursor = Math.max(videoCursor, cursor); // final duration = longest lane
  }

  // ── audio ──
  const audio: AudioPlacementPlan[] = [];
  let lastAudioEnd = 0;
  for (const n of timeline.narration) {
    const placement = planAudioForNarration(n, projectDir);
    if (!placement) continue;
    // Apply the clip's voiceover-lane mix settings. A MUTED lane contributes
    // nothing to the output — drop its placements entirely (they also don't
    // extend the timeline's audio tail). A lane volume scales the placement's
    // bus gain; stitch turns gain ≠ 1 into a `volume=` filter.
    const lane = typeof n.track === "number" && n.track > 0 ? Math.floor(n.track) : 0;
    const { volume, muted } = resolveAudioLane(timeline, lane);
    if (muted) continue;
    placement.gain = volume;
    audio.push(placement);
    lastAudioEnd = Math.max(lastAudioEnd, placement.startSec + placement.durationSec);
  }
  audio.sort((a, b) => a.startSec - b.startSec);

  // ── captions ──
  // Build CaptionPlan entries when the project opted in. Caption duration
  // tracks the audio when rendered, else falls back to estDurationSec so
  // captions stay timed-correctly while clips are still red.
  const captions: CaptionPlan[] = [];
  if (timeline.captions?.enabled) {
    // A rendered clip's caption tracks its TRIMMED played length (from the
    // audio placement), not the full audio file — so trimming the clip also
    // shortens its caption. Red clips fall back to the estimate.
    const playedDurById = new Map(audio.map((a) => [a.id, a.durationSec]));
    for (const n of timeline.narration) {
      const text = (n.narration || "").trim();
      if (!text) continue;
      // A muted lane contributes nothing to the output — drop its captions too
      // (the clip's audio placement was already dropped above, so its trimmed
      // played length isn't in playedDurById anyway). Keeps the burned-in
      // caption consistent with "muted = not in the export".
      const lane = typeof n.track === "number" && n.track > 0 ? Math.floor(n.track) : 0;
      if (resolveAudioLane(timeline, lane).muted) continue;
      const durationSec = n.audio
        ? (playedDurById.get(n.id) ?? (Number(n.audio.durationSec) || 0))
        : Number(n.estDurationSec) || 0;
      if (durationSec <= EPS) continue;
      captions.push({
        id: n.id,
        text,
        startSec: Number(n.startSec) || 0,
        durationSec,
      });
    }
    captions.sort((a, b) => a.startSec - b.startSec);
  }

  // ── text overlays ──
  // Independent of caption settings; each overlay is its own opt-in
  // entity. Empty text overlays are silently dropped (drawtext with no
  // text would error anyway). Sorted by startSec for predictable
  // graph order.
  const textOverlays: TextOverlayPlan[] = [];
  for (const o of timeline.textOverlays ?? []) {
    const text = (o.text || "").trim();
    if (!text) continue;
    const durationSec = Number(o.durationSec) || 0;
    if (durationSec <= EPS) continue;
    textOverlays.push({
      id: o.id,
      text,
      startSec: Number(o.startSec) || 0,
      durationSec,
      vertical: o.position?.vertical ?? "bottom",
      horizontal: o.position?.horizontal ?? "center",
      fontSize: Number(o.style?.fontSize) || 36,
      color: o.style?.color || "white",
      boxColor: o.style?.boxColor ?? "rgba(0,0,0,0.55)",
    });
  }
  textOverlays.sort((a, b) => a.startSec - b.startSec);

  const finalDurationSec = Math.max(videoCursor, lastAudioEnd);
  return {
    video,
    audio,
    captions,
    textOverlays,
    videoTotalSec: videoCursor,
    finalDurationSec,
    freezeExtendSec: Math.max(0, finalDurationSec - videoCursor),
  };
}

/** Resolve a single narration entry to an AudioPlacementPlan, or null if
 *  it's still red (unrendered) or its `narrationHash` has drifted from the
 *  current `narration` text (operator edited the text post-render — the
 *  audio no longer matches and is treated as invalidated). */
function planAudioForNarration(
  n: NarrationClip,
  projectDir: string,
): AudioPlacementPlan | null {
  if (!n.audio) return null;
  // narrationHash drift is enforced at the UI/save boundary in Phase 1.3;
  // the planner trusts the manifest. (We could re-check the hash here
  // but it would silently drop clips that the operator might want to
  // keep around for a moment before re-rendering — better to surface
  // the warning in the editor.)
  const fileDur = Number(n.audio.durationSec) || 0;
  // Resolve trim points. Absent ⇒ full audio. Clamp the in-point into the
  // real audio; the out-point may legitimately exceed it (trailing silence)
  // but must stay past the in-point by at least a frame.
  const inSec = Math.max(0, Math.min(Number(n.audioInSec ?? 0) || 0, Math.max(0, fileDur - EPS)));
  const rawOut = Number(n.audioOutSec ?? fileDur);
  const outSec = Math.max(inSec + EPS, rawOut > 0 ? rawOut : fileDur);
  return {
    id: n.id,
    audioPath: path.isAbsolute(n.audio.path) ? n.audio.path : path.resolve(projectDir, n.audio.path),
    startSec: n.startSec,
    durationSec: outSec - inSec,
    sourceInSec: inSec,
    sourceOutSec: outSec,
    audioFileDurationSec: fileDur,
    gain: 1,
  };
}

/** Pre-stitch validation that doesn't depend on probing files. Surfaces
 *  the kinds of mistakes the UI guards against, with a stable error
 *  message stitchCommand can show the operator. */
export function validateTimeline(timeline: Timeline): void {
  // The planner already enforces most invariants; one extra check here
  // catches a corrupted manifest that survived schema validation.
  if (timeline.video.length === 0) throw new Error("timeline has no video clips");
  if (timeline.sources.length === 0) throw new Error("timeline has no video sources");
}

// Re-export old API name to ease future refactors that hunt for callers.
export { type VideoClip };

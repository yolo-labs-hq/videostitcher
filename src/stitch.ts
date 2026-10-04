import { promises as fs } from "node:fs";
import path from "node:path";
import type { Timeline } from "./types.js";
import { planTimeline, validateTimeline, type TimelinePlan } from "./timing.js";
import { probeDuration, probeDimensions, runFfmpeg } from "./ffmpeg.js";
import { FILES, projectPath } from "./project.js";
import { loadFoleySidecars, remapFoleyEvents, renderFoleyWav } from "./foley.js";

const EPS = 1e-3;

/** Font path inside the videostitcher container image. fonts-dejavu-core
 *  is apt-installed in the Dockerfile precisely so this path is stable. */
const CAPTION_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/** Format a number for an ffmpeg filter arg (trim trailing zeros, cap precision). */
const n = (v: number): string => (+v.toFixed(4)).toString();

/** Escape a path so it survives ffmpeg's filter-param parser. Colons are
 *  the param separator and backslashes are the escape char — both have to
 *  be backslash-prefixed inside a filter arg. Project paths under
 *  /home/yolo/.../audio/ shouldn't contain either; this is defensive
 *  against future paths with weirder characters. */
function ffmpegFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Normalise a CSS-style color string into something ffmpeg's filter-param
 * parser accepts. `rgba(R,G,B,A)` / `rgb(R,G,B)` have COMMAS inside them
 * which ffmpeg treats as filter-chain separators (the parser doesn't see
 * parens) — passing those through verbatim breaks the entire graph with
 * "No option name near '10:x=(w-text_w)/2'" because the chain ends up
 * split mid-arg. Convert to ffmpeg's native `0xRRGGBB@A` form. Named
 * colors (`white`, `black@0.55`) and hex (`#fff`) pass through unchanged.
 */
export function ffmpegColor(s: string): string {
  if (!s) return s;
  const t = s.trim();
  const m = t.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    const r = Math.max(0, Math.min(255, +m[1]!));
    const g = Math.max(0, Math.min(255, +m[2]!));
    const b = Math.max(0, Math.min(255, +m[3]!));
    const a = m[4] != null ? Math.max(0, Math.min(1, +m[4]!)) : 1;
    const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
    return a >= 0.999 ? `0x${hex}` : `0x${hex}@${(+a.toFixed(3))}`;
  }
  // Three-digit hex (#rgb) → #rrggbb so ffmpeg accepts it.
  const short = t.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    const [, r, g, b] = short;
    return `0x${r}${r}${g}${g}${b}${b}`;
  }
  // Already in ffmpeg-acceptable shape (named, hex, hex@alpha, name@alpha).
  return t;
}

/**
 * Build the `-filter_complex` graph plus the ordered input file list for a
 * TimelinePlan.
 *
 * Graph shape:
 *   - One -i per unique source video file, then one -i per audio placement.
 *   - Per video clip: trim → setpts → [vN].
 *   - All [vN] concat (n=1 is fine — passthrough) → [vcat].
 *   - If audio overruns: tpad clones the last frame → [vout]. Else [vcat] is
 *     aliased through `null` → [vout] so the output label is always [vout].
 *   - Per audio placement: aresample/aformat → adelay (timeline-start) → apad
 *     to finalDur → atrim → [aN].
 *   - All [aN] amix(normalize=0) → [aout]. With zero placements, anullsrc
 *     fills [aout] with silence so the output map stays homogeneous.
 *
 * Exported so the unit tests can pin the graph shape without launching
 * ffmpeg — pure string construction.
 */
export interface BuildFilterOptions {
  /** Map of captionId → absolute path to the textfile holding that
   *  caption's text. stitch() writes these files before calling
   *  buildFilterGraph; pure-string tests can synthesise the paths. */
  captionTextFiles?: Map<string, string>;
  /** Same shape for text-overlay textfiles. Lives in a separate map so
   *  the textfile paths don't collide if an operator happens to use the
   *  same id for a narration and an overlay (vanishingly unlikely, but
   *  the type system shouldn't pretend they're the same namespace). */
  overlayTextFiles?: Map<string, string>;
  /** Common output resolution to normalize every clip to before concat.
   *  Required when sources have differing resolutions — otherwise the
   *  concat frame size varies per clip and drawtext's (w-text_w)/2 /
   *  h-text_h positions shift between clips. Absent ⇒ no scaling (all
   *  clips already share a resolution, e.g. single source). */
  normalizeTo?: { width: number; height: number };
  /** Output frame height, used to size captions proportionally (fontsize,
   *  bottom offset, box border). Absent ⇒ legacy fixed 28px metrics. */
  videoHeight?: number;
}

/** Compute the ffmpeg `x=`/`y=` expressions for an overlay's position
 *  bucket. Same 48px padding the caption style uses, so a bottom-center
 *  overlay sits exactly where a caption would. */
function overlayCoordExprs(vertical: string, horizontal: string): { x: string; y: string } {
  const PAD = 48;
  const x = horizontal === "left"
    ? `${PAD}`
    : horizontal === "right"
      ? `w-text_w-${PAD}`
      : `(w-text_w)/2`;
  const y = vertical === "top"
    ? `${PAD}`
    : vertical === "bottom"
      ? `h-text_h-${PAD}`
      : `(h-text_h)/2`;
  return { x, y };
}

export function buildFilterGraph(plan: TimelinePlan, opts: BuildFilterOptions = {}): { inputs: string[]; filter: string } {
  // Map each unique source path to an input index. Same source referenced
  // by multiple clips reuses one -i (ffmpeg trims the same input multiple
  // times via split-trim chains).
  const inputs: string[] = [];
  const srcIdx = new Map<string, number>();
  for (const v of plan.video) {
    if (!srcIdx.has(v.sourcePath)) {
      srcIdx.set(v.sourcePath, inputs.length);
      inputs.push(v.sourcePath);
    }
  }
  // Then audio files, indexed after video sources.
  const audioInputBase = inputs.length;
  for (const a of plan.audio) {
    inputs.push(a.audioPath);
  }

  const parts: string[] = [];

  // ── per-clip video trims ──
  // Multiple clips MAY reference the same source. ffmpeg accepts the same
  // input pad in multiple filter chains as long as you split it first; the
  // simpler form `[i:v]trim=…` works directly when each chain consumes
  // its OWN trim filter (ffmpeg splits implicitly under the hood). If we
  // later support more aggressive reuse we can add explicit `split`.
  // When sources differ in resolution, every clip is scaled (preserving
  // aspect) + padded to a common WxH and SAR reset, so the concat output
  // has ONE frame size. Without this, drawtext's w/h-relative caption
  // positions land differently on clips of different sizes. Single-
  // resolution projects skip this entirely (no re-scale, no quality hit).
  const norm = opts.normalizeTo;
  const normFilter = norm
    ? `,scale=${norm.width}:${norm.height}:force_original_aspect_ratio=decrease,` +
      `pad=${norm.width}:${norm.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    : "";
  plan.video.forEach((v, i) => {
    const sIdx = srcIdx.get(v.sourcePath)!;
    // Per-clip speed: dividing PTS by `speed` compresses time (>1 = faster)
    // or expands it (<1 = slower), so the trimmed slice plays in
    // (sourceOutSec − sourceInSec) / speed output seconds — matching the
    // effective duration the planner used for the timeline cursor. speed === 1
    // keeps the prior `setpts=PTS-STARTPTS` graph byte-for-byte (no regression).
    const speed = v.speed && v.speed > 0 ? v.speed : 1;
    const setpts =
      Math.abs(speed - 1) > EPS ? `setpts=(PTS-STARTPTS)/${n(speed)}` : `setpts=PTS-STARTPTS`;
    parts.push(
      `[${sIdx}:v]trim=start=${n(v.sourceInSec)}:end=${n(v.sourceOutSec)},${setpts}${normFilter}[v${i}]`,
    );
  });

  // ── video concat ──
  // concat with n=1 is a valid passthrough; ffmpeg simply forwards the
  // single input. Keeps the graph homogeneous for downstream tpad.
  const vLabels = plan.video.map((_, i) => `[v${i}]`).join("");
  parts.push(`${vLabels}concat=n=${plan.video.length}:v=1:a=0[vcat]`);

  // ── freeze-extend if audio overruns ──
  // Captions + text overlays (if any) live AFTER tpad so they're drawn
  // over the extended freeze frame too. Use a stable [vfin] intermediate
  // label so the overlay emit doesn't have to know which freeze branch ran.
  const hasAnyOverlay = plan.captions.length > 0 || plan.textOverlays.length > 0;
  const vfinLabel = hasAnyOverlay ? "[vfin]" : "[vout]";
  if (plan.freezeExtendSec > EPS) {
    parts.push(`[vcat]tpad=stop_mode=clone:stop_duration=${n(plan.freezeExtendSec)}${vfinLabel}`);
  } else {
    // `null` is a passthrough video filter; aliases vcat → vfin/vout so
    // the output map name is stable regardless of the freeze branch.
    parts.push(`[vcat]null${vfinLabel}`);
  }

  // ── captions + text overlays ──
  // Both use the same drawtext primitive; differences are style +
  // position knobs. We emit captions first then overlays so an overlay
  // drawn at the same position lands on top (predictable layering).
  // textfile= reads the literal text from disk (dodges the filter-param
  // escaping trap for commas / colons / single-quotes / percent signs).
  // Caption metrics scale with the output height so captions read the same
  // size whatever the resolution. Fixed 28px/48px/12px legacy defaults when
  // height is unknown (keeps pure-string tests stable).
  const capFontSize = opts.videoHeight ? Math.max(16, Math.round(opts.videoHeight / 26)) : 28;
  const capBottomPad = opts.videoHeight ? Math.max(24, Math.round(opts.videoHeight / 22)) : 48;
  const capBoxBorder = opts.videoHeight ? Math.max(6, Math.round(opts.videoHeight / 90)) : 12;
  if (hasAnyOverlay) {
    const drawTexts: string[] = [];

    for (const c of plan.captions) {
      const file = opts.captionTextFiles?.get(c.id);
      if (!file) throw new Error(`buildFilterGraph: no textfile for caption ${c.id}`);
      const start = n(c.startSec);
      const end = n(c.startSec + c.durationSec);
      drawTexts.push([
        `drawtext=textfile=${ffmpegFilterPath(file)}`,
        `fontfile=${ffmpegFilterPath(CAPTION_FONT_PATH)}`,
        `fontsize=${capFontSize}`,
        `fontcolor=white`,
        `box=1`,
        `boxcolor=black@0.55`,
        `boxborderw=${capBoxBorder}`,
        `x=(w-text_w)/2`,
        `y=h-text_h-${capBottomPad}`,
        `line_spacing=6`,
        // `lt(t,end)` semantics inside between() means we cleanly hand
        // off when two captions abut.
        `enable='between(t\\,${start}\\,${end})'`,
      ].join(":"));
    }

    for (const o of plan.textOverlays) {
      const file = opts.overlayTextFiles?.get(o.id);
      if (!file) throw new Error(`buildFilterGraph: no textfile for overlay ${o.id}`);
      const { x, y } = overlayCoordExprs(o.vertical, o.horizontal);
      const start = n(o.startSec);
      const end = n(o.startSec + o.durationSec);
      const args: string[] = [
        `drawtext=textfile=${ffmpegFilterPath(file)}`,
        `fontfile=${ffmpegFilterPath(CAPTION_FONT_PATH)}`,
        `fontsize=${Math.round(o.fontSize)}`,
        // Colors get normalised — the UI accepts CSS-ish strings
        // ("white", "#ff0", "rgba(255,0,0,0.8)"), but ffmpeg's filter-
        // param parser treats commas as chain separators and so trips
        // on the rgba() form. ffmpegColor() converts to 0xRRGGBB@A.
        `fontcolor=${ffmpegColor(o.color)}`,
      ];
      if (o.boxColor && o.boxColor.trim()) {
        args.push(`box=1`, `boxcolor=${ffmpegColor(o.boxColor)}`, `boxborderw=10`);
      }
      args.push(
        `x=${x}`,
        `y=${y}`,
        `line_spacing=6`,
        `enable='between(t\\,${start}\\,${end})'`,
      );
      drawTexts.push(args.join(":"));
    }

    parts.push(`[vfin]${drawTexts.join(",")}[vout]`);
  }

  // ── audio bus ──
  if (plan.audio.length === 0) {
    // Pure silence the same length as the video.
    parts.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,` +
        `atrim=0:${n(plan.finalDurationSec)},asetpts=PTS-STARTPTS[aout]`,
    );
  } else {
    plan.audio.forEach((a, i) => {
      const inputIdx = audioInputBase + i;
      // adelay = milliseconds; `all=1` applies the first delay to every
      // channel so stereo placement stays put. We always normalise to
      // 48k stereo float-planar so amix doesn't get a heterogeneous mix.
      const delayMs = Math.max(0, Math.round(a.startSec * 1000));
      const delay = delayMs > 0 ? `adelay=delays=${delayMs}:all=1,` : "";
      // Per-clip source trim: only when the played slice [sourceInSec,
      // sourceOutSec] differs from the whole audio file. Untrimmed clips
      // keep the prior graph byte-for-byte (no regression). atrim takes
      // the slice, asetpts rezeroes it, and apad=whole_dur=<slice> pads
      // the tail with silence when the out-point runs past the real audio
      // (the "extend = silence" case). The delay/finalDur apad+atrim that
      // place the clip on the bus then run unchanged.
      const sliceDur = Math.max(0, a.sourceOutSec - a.sourceInSec);
      const isTrimmed =
        Math.abs(a.sourceInSec) > EPS ||
        Math.abs(a.sourceOutSec - a.audioFileDurationSec) > EPS;
      const srcTrim = isTrimmed
        ? `atrim=start=${n(a.sourceInSec)}:end=${n(a.sourceOutSec)},asetpts=PTS-STARTPTS,` +
          `apad=whole_dur=${n(sliceDur)},`
        : "";
      // Per-lane gain (from the clip's voiceover-lane volume). Only emitted
      // when it actually changes the level, so 1× clips keep the prior graph
      // byte-for-byte (no regression). Muted lanes never reach the plan.
      const gain = typeof a.gain === "number" && a.gain >= 0 ? a.gain : 1;
      const gainF = Math.abs(gain - 1) > EPS ? `volume=${n(gain)},` : "";
      parts.push(
        `[${inputIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `${srcTrim}${gainF}${delay}apad=whole_dur=${n(plan.finalDurationSec)},` +
          `atrim=0:${n(plan.finalDurationSec)},asetpts=PTS-STARTPTS[a${i}]`,
      );
    });
    if (plan.audio.length === 1) {
      // amix with n=1 works but is wasted; alias through anull.
      parts.push(`[a0]anull[aout]`);
    } else {
      const aLabels = plan.audio.map((_, i) => `[a${i}]`).join("");
      // normalize=0 keeps single-clip moments at full level; we accept
      // that overlapping clips will sum (and may clip) — the operator
      // chose to overlap them.
      parts.push(`${aLabels}amix=inputs=${plan.audio.length}:normalize=0[aout]`);
    }
  }

  return { inputs, filter: parts.join(";") };
}

export interface StitchOptions {
  projectDir: string;
  timeline: Timeline;
  outPath?: string;
  /** Override for the 720p proxy path (defaults to FILES.outputPreview). */
  previewPath?: string;
  onProgress?: (line: string) => void;
}

export interface StitchResult {
  outPath: string;
  /** Path to the 720p streaming proxy, or undefined if its (best-effort)
   *  encode failed — callers fall back to outPath. */
  previewPath?: string;
  plan: TimelinePlan;
  videoTotalSec: number;
  finalDurationSec: number;
  freezeExtendSec: number;
}

/** Render the final video: every video clip in timeline.video[] concatenated,
 *  with every narration's rendered audio placed on the audio bus at its
 *  startSec. If the audio extends past the video, the last frame is held to
 *  cover the tail. */
export async function stitch(opts: StitchOptions): Promise<StitchResult> {
  validateTimeline(opts.timeline);
  const plan = planTimeline(opts.timeline, opts.projectDir);
  if (plan.video.length === 0) {
    // Schema guarantees video.length >= 1, but planTimeline could in
    // principle filter; defensively short-circuit before ffmpeg.
    throw new Error("no video clips in plan — nothing to stitch");
  }

  // Cross-check every source on disk to fail fast with a clear error, and
  // collect the dimensions of the sources actually used by the plan so we
  // can normalize a mixed-resolution timeline to one frame size.
  const usedPaths = new Set(plan.video.map((v) => v.sourcePath));
  const usedDims: Array<{ width: number; height: number }> = [];
  for (const src of opts.timeline.sources) {
    const p = path.isAbsolute(src.filePath)
      ? src.filePath
      : path.resolve(opts.projectDir, src.filePath);
    try {
      await probeDuration(p);
    } catch (err) {
      throw new Error(`source ${src.id} (${p}) is unreadable: ${(err as Error).message}`);
    }
    if (usedPaths.has(p)) {
      try { usedDims.push(await probeDimensions(p)); } catch { /* dims optional */ }
    }
  }
  // Canonical output resolution. Max width/height across the used sources
  // (rounded to even for yuv420p/libx264). We only force a per-clip
  // scale+pad when the sources actually differ — a single-resolution
  // project keeps its native frames untouched.
  let canonical: { width: number; height: number } | null = null;
  let needsNormalize = false;
  if (usedDims.length > 0) {
    const even = (x: number) => (x % 2 === 0 ? x : x + 1);
    canonical = {
      width: even(Math.max(...usedDims.map((d) => d.width))),
      height: even(Math.max(...usedDims.map((d) => d.height))),
    };
    needsNormalize = new Set(usedDims.map((d) => `${d.width}x${d.height}`)).size > 1;
  }

  // Write per-caption + per-overlay textfiles to disk so ffmpeg's
  // drawtext can read them literally (no escaping headaches). Files
  // live under <projectDir>/{captions,overlays}/<id>.txt; dirs are
  // created idempotently. Orphan files from prior renders are
  // overwritten by ids that survived, and the stitch is single-shot
  // so leftovers stop accruing once the operator stops adding/removing.
  let captionTextFiles: Map<string, string> | undefined;
  if (plan.captions.length > 0) {
    const captionsDir = path.join(opts.projectDir, "captions");
    await fs.mkdir(captionsDir, { recursive: true });
    captionTextFiles = new Map();
    for (const c of plan.captions) {
      const file = path.join(captionsDir, `${c.id}.txt`);
      await fs.writeFile(file, c.text, "utf8");
      captionTextFiles.set(c.id, file);
    }
  }
  let overlayTextFiles: Map<string, string> | undefined;
  if (plan.textOverlays.length > 0) {
    const overlaysDir = path.join(opts.projectDir, "overlays");
    await fs.mkdir(overlaysDir, { recursive: true });
    overlayTextFiles = new Map();
    for (const o of plan.textOverlays) {
      const file = path.join(overlaysDir, `${o.id}.txt`);
      await fs.writeFile(file, o.text, "utf8");
      overlayTextFiles.set(o.id, file);
    }
  }

  // ── auto-foley ──
  // When a source carries an inputs.json sidecar (screencast takes record
  // click/keypress timestamps), render a foley track and ride the existing
  // audio bus as one extra placement at t=0. Best-effort by contract: foley
  // must NEVER fail a stitch — any error just skips the track.
  if (opts.timeline.foley?.enabled !== false) {
    try {
      const sidecars = await loadFoleySidecars(opts.timeline, opts.projectDir);
      if (sidecars.size > 0) {
        const events = remapFoleyEvents(opts.timeline, sidecars);
        if (events.length > 0) {
          const foleyPath = path.join(opts.projectDir, FILES.audioDir, "foley.wav");
          const rendered = await renderFoleyWav(events, foleyPath, {
            totalDurationSec: plan.finalDurationSec,
            samplesDir: path.join(opts.projectDir, "foley-samples"),
            volume: opts.timeline.foley?.volume ?? 1,
          });
          plan.audio.push({
            id: "__foley__",
            audioPath: foleyPath,
            startSec: 0,
            durationSec: rendered.durationSec,
            sourceInSec: 0,
            sourceOutSec: rendered.durationSec,
            audioFileDurationSec: rendered.durationSec,
            // Foley gain is already baked into the rendered wav (renderFoleyWav
            // applied opts.timeline.foley.volume); ride the bus at unity.
            gain: 1,
          });
        }
      }
    } catch (err) {
      process.stderr.write(
        `[stitch] foley skipped: ${(err as Error)?.message ?? err}\n`,
      );
    }
  }

  const { inputs, filter } = buildFilterGraph(plan, {
    captionTextFiles,
    overlayTextFiles,
    normalizeTo: needsNormalize && canonical ? canonical : undefined,
    videoHeight: canonical?.height,
  });
  const outPath = opts.outPath ?? projectPath(opts.projectDir, FILES.output);

  const args = [
    "-y",
    ...inputs.flatMap((p) => ["-i", p]),
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outPath,
  ];

  await runFfmpeg(args, opts.onProgress);

  // Second pass: a light, STREAMING-OPTIMIZED 720p proxy for smooth in-page
  // playback. Captions are already baked into `outPath` and scale down
  // cleanly. Tuned for delivery over a constrained / flaky connection
  // (in-page playback stutters there even though the file plays fine
  // locally): width capped at 1280, SAR reset to 1 (clean square pixels),
  // a hard bitrate ceiling via -maxrate/-bufsize so a complex moment can't
  // blow the client's buffer, and a fixed 2s GOP (-g/-keyint_min/
  // -sc_threshold) so playback recovers quickly after a network hiccup.
  // Best-effort: the full-res output already succeeded, so a proxy failure
  // must not fail the stitch — the player falls back to `outPath`. Remove
  // any stale proxy first so a failed pass can't leave an old preview.
  const previewPath = opts.previewPath ?? projectPath(opts.projectDir, FILES.outputPreview);
  let previewOut: string | undefined;
  try { await fs.rm(previewPath, { force: true }); } catch { /* */ }
  try {
    await runFfmpeg(
      [
        "-y",
        "-i", outPath,
        "-vf", "scale='min(1280,iw)':-2:flags=bicubic,setsar=1",
        // CRITICAL: force a CONSTANT frame rate. Screen recordings are
        // typically variable-frame-rate (VFR); the transcode otherwise
        // passes that irregular frame timing through, and the BROWSER's
        // streaming decoder stalls on it — firing `waiting` with the data
        // already fully buffered (diagnosed via the in-tile vid-diag panel:
        // ahead=25s, net=IDLE, yet stalling). Desktop players (VLC, etc.)
        // tolerate VFR, which is why the downloaded full-res file played
        // fine locally while the proxy hitched in-page. -r 30 resamples to
        // a uniform 30fps timeline (plenty for a screencast preview).
        "-r", "30",
        "-c:v", "libx264",
        "-profile:v", "main",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        // Aggressively low bitrate for real-time streaming over a marginal /
        // flaky connection (in-page playback stalled at ~1.2Mbps even though
        // the file plays fine locally — it's delivery-bound, not the encode).
        // Screencasts are mostly-static and compress to a fraction of this,
        // so 720p still looks clean. crf is the quality floor; maxrate/bufsize
        // are the hard ceiling that keeps the stream within a slow pipe.
        "-crf", "30",
        "-maxrate", "700k",
        "-bufsize", "1400k",
        "-g", "60",
        "-keyint_min", "60",
        "-sc_threshold", "0",
        "-c:a", "aac",
        "-b:a", "96k",
        "-movflags", "+faststart",
        previewPath,
      ],
      opts.onProgress,
    );
    previewOut = previewPath;
  } catch { previewOut = undefined; }

  return {
    outPath,
    previewPath: previewOut,
    plan,
    videoTotalSec: plan.videoTotalSec,
    finalDurationSec: plan.finalDurationSec,
    freezeExtendSec: plan.freezeExtendSec,
  };
}

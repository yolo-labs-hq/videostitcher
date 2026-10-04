import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AnalysisSchema,
  SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  type Analysis,
  type AnalysisSegment,
  type Timeline,
} from "../types.js";
import { FILES, loadProject, projectPath, saveTimeline } from "../project.js";
import { writeJsonArtifact } from "../project.js";
import { estimateNarrationDurationSec } from "../narrationHash.js";
import { probeDuration } from "../ffmpeg.js";
import {
  analyzeVideo,
  mimeForVideo,
  resolveApiKey,
  uploadVideo,
  waitForActive,
  type ResponseSchema,
} from "../gemini.js";
import { info, ok, step, warn } from "../log.js";

const EPS = 1e-3;

/** Shape Gemini is asked to return (a JSON-schema subset). */
const RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSec: { type: "number" },
          endSec: { type: "number" },
          transition: { type: "string" },
          visualSummary: { type: "string" },
          onScreenText: { type: "array", items: { type: "string" } },
          keyAction: { type: "string" },
          suggestedBeat: { type: "string" },
        },
        required: ["startSec", "endSec", "visualSummary"],
      },
    },
  },
  required: ["segments"],
};

function buildPrompt(durationSec: number, brief: string): string {
  // Cap the segment count so a long recording doesn't produce thousands
  // of sub-second segments — that's both unreadable in the editor and
  // tends to bust Gemini's output-token cap (truncating mid-JSON, see
  // gemini.ts MAX_TOKENS check). Target ~6s per segment with sane
  // floor/ceiling.
  const targetSegmentCount = Math.max(3, Math.min(80, Math.round(durationSec / 6)));
  return [
    "You are a screencast analyst preparing a video for voiceover narration.",
    `Analyze this screen recording (${durationSec.toFixed(1)} seconds long) and break it into`,
    "sequential segments aligned to meaningful visual transitions — scene changes, navigation,",
    "new screens or dialogs, and major UI state changes.",
    "",
    "For each segment provide:",
    "- startSec, endSec: floating-point seconds from the start of the video",
    "- visualSummary: one sentence describing what is shown and happening",
    "- transition: how this segment begins (e.g. cut, fade, scroll, navigation)",
    "- onScreenText: salient visible text/labels (array, may be empty)",
    "- keyAction: the primary user action in this segment",
    "- suggestedBeat: a short note on what the narration should cover here",
    "",
    "Requirements:",
    "- Segments MUST be ordered, MUST NOT overlap, and should be contiguous",
    `  covering the whole video from 0 to ${durationSec.toFixed(1)}s.`,
    `- Each segment MUST be at least 3 seconds long (endSec − startSec ≥ 3.0).`,
    `  Sub-second or frame-by-frame segments are wrong — group fast UI changes`,
    `  into a single segment whose visualSummary covers them.`,
    `- Aim for approximately ${targetSegmentCount} segments total (~${Math.round(durationSec / targetSegmentCount)}s each).`,
    `  Hard cap: never produce more than ${Math.max(targetSegmentCount * 2, 30)} segments.`,
    brief ? `\nContext about this recording:\n${brief}` : "",
  ].join("\n");
}

/**
 * Repair raw model segments into a clean, ordered, non-overlapping timeline
 * clamped to the real video duration. Gemini timestamps are approximate and
 * occasionally overlap or run past the end, so this is load-bearing.
 */
export function normalizeAnalysisSegments(
  raw: Array<Partial<AnalysisSegment>>,
  durationSec: number,
): AnalysisSegment[] {
  const sorted = [...raw]
    .filter((s) => typeof s.startSec === "number" && typeof s.endSec === "number")
    .sort((a, b) => (a.startSec! - b.startSec!) || (a.endSec! - b.endSec!));

  const out: AnalysisSegment[] = [];
  let prevEnd = 0;
  for (const s of sorted) {
    let start = Math.max(0, Math.min(s.startSec!, durationSec));
    const end = Math.max(0, Math.min(s.endSec!, durationSec));
    // Remove overlap with the previous segment by pulling the start forward.
    if (start < prevEnd) start = prevEnd;
    if (end - start <= EPS) continue; // collapsed away — drop

    out.push({
      id: `seg-${String(out.length + 1).padStart(3, "0")}`,
      startSec: +start.toFixed(3),
      endSec: +end.toFixed(3),
      transition: s.transition,
      visualSummary: s.visualSummary,
      onScreenText: s.onScreenText,
      keyAction: s.keyAction,
      suggestedBeat: s.suggestedBeat,
    });
    prevEnd = end;
  }
  return out;
}

export interface AnalyzeCommandOptions {
  apiKey?: string;
  model?: string;
  fps?: number;
  draftScript?: boolean;
  /** Re-run analyze even if a prior analysis.json exists on disk. Without
   *  this flag, the existing analysis is loaded and returned — no Gemini
   *  call, no upload, no billing. The pipeline (`run` command) already
   *  short-circuited this way; the manual `analyze` command did not, so
   *  every UI click re-billed. */
  force?: boolean;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

export async function analyzeCommand(projectDir: string, opts: AnalyzeCommandOptions): Promise<Analysis> {
  const project = await loadProject(projectDir);
  const model = opts.model || DEFAULT_MODEL;

  // Reuse-by-default: if analysis.json already exists, load + return it
  // without touching Gemini. Operators force a fresh run via opts.force
  // (the UI wraps this behind a "Re-analyze (will re-bill)" confirm).
  const analysisFile = projectPath(projectDir, FILES.analysis);
  if (!opts.force) {
    let cached: string | null = null;
    try { cached = await fs.readFile(analysisFile, "utf8"); } catch { /* none */ }
    if (cached) {
      try {
        const parsed = AnalysisSchema.parse(JSON.parse(cached));
        ok(`reused ${FILES.analysis} (${parsed.segments.length} segment(s), pass force:true to re-analyze)`);
        return parsed;
      } catch (err) {
        warn(`existing ${FILES.analysis} failed validation, re-running analyze: ${(err as Error).message}`);
      }
    }
  }

  const durationSec = await probeDuration(project.videoPath);
  const mimeType = mimeForVideo(project.videoPath);
  const apiKey = resolveApiKey(opts.apiKey);

  step(`Analyzing "${project.name}" with ${model} (${durationSec.toFixed(1)}s, ${mimeType})`);

  info("  uploading video…");
  const uploaded = await uploadVideo({
    apiKey,
    filePath: project.videoPath,
    mimeType,
    displayName: project.name,
  });
  ok(`uploaded ${uploaded.name}`);

  info("  waiting for Gemini to process the video…");
  await waitForActive({ apiKey, name: uploaded.name, onTick: () => {} });
  ok("video is ACTIVE");

  info("  generating analysis…");
  const text = await analyzeVideo({
    apiKey,
    model,
    fileUri: uploaded.uri,
    mimeType: uploaded.mimeType,
    prompt: buildPrompt(durationSec, project.brief),
    fps: opts.fps,
    responseSchema: RESPONSE_SCHEMA,
  });

  let parsed: { segments?: Array<Partial<AnalysisSegment>> };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini did not return valid JSON: ${(err as Error).message}\n${text.slice(0, 300)}`);
  }
  const segments = normalizeAnalysisSegments(parsed.segments ?? [], durationSec);
  if (segments.length === 0) {
    throw new Error("Gemini returned no usable segments");
  }

  const analysis: Analysis = AnalysisSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    durationSec,
    fps: opts.fps,
    brief: project.brief,
    segments,
  });
  await writeJsonArtifact(projectPath(projectDir, FILES.analysis), analysis);
  ok(`wrote ${FILES.analysis} (${segments.length} segment(s))`);

  // Report any coverage gaps so the operator knows what stitch will keep silent.
  reportCoverage(segments, durationSec);

  if (opts.draftScript) {
    await writeDraftTimeline(projectDir, analysis);
  }
  return analysis;
}

function reportCoverage(segments: AnalysisSegment[], durationSec: number): void {
  let prevEnd = 0;
  let gaps = 0;
  for (const s of segments) {
    if (s.startSec - prevEnd > 0.25) gaps++;
    prevEnd = s.endSec;
  }
  if (durationSec - prevEnd > 0.25) gaps++;
  if (gaps > 0) {
    warn(`${gaps} uncovered gap(s) in the timeline — stitch will keep that footage silent`);
  }
}

/** Convenience: emit a placeholder timeline.json so the pipeline is runnable
 *  before the Claude `script` stage runs. Narration is just the suggested
 *  beat / visual summary — meant to be rewritten — and every clip starts red. */
async function writeDraftTimeline(projectDir: string, analysis: Analysis): Promise<void> {
  const project = await loadProject(projectDir);
  const timeline: Timeline = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    durationSec: analysis.durationSec,
    voice: { modelId: "eleven_turbo_v2_5", stability: 0.5, similarityBoost: 0.75 },
    captions: { enabled: false },
    foley: { enabled: true, volume: 1 },
    textOverlays: [],
    sources: [{ id: "src-001", filePath: project.videoPath, displayName: project.name }],
    video: [{
      id: "vid-001",
      sourceId: "src-001",
      sourceInSec: 0,
      sourceOutSec: analysis.durationSec,
      timelineStartSec: 0,
    }],
    narration: analysis.segments.map((s) => {
      const text = (s.suggestedBeat || s.visualSummary || "").trim();
      return {
        id: s.id,
        startSec: s.startSec,
        narration: text,
        pauseAfterSec: 0,
        estDurationSec: estimateNarrationDurationSec(text),
        audio: null,
      };
    }),
  };
  await saveTimeline(projectDir, timeline);
  warn(`wrote DRAFT ${FILES.timeline} from the analysis — placeholder narration, rewrite before voicing`);
}

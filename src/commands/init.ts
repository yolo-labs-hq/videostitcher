import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  type Project,
  type Timeline,
} from "../types.js";
import { FILES, ensureDir, projectPath, saveProject, saveTimeline } from "../project.js";
import { probeDuration } from "../ffmpeg.js";
import { estimateNarrationDurationSec } from "../narrationHash.js";
import { ok, step, warn } from "../log.js";

export interface InitOptions {
  brief?: string;
  name?: string;
  dir?: string;
  /** Write a minimal timeline.json with one placeholder narration clip so
   *  `mock-voice` + `stitch` can be exercised without running analyze + script. */
  scaffoldScript?: boolean;
}

/** Treat --brief as a file path if it points at one, else as literal text. */
async function resolveBrief(brief: string | undefined): Promise<string> {
  if (!brief) return "";
  try {
    const stat = await fs.stat(brief);
    if (stat.isFile()) return (await fs.readFile(brief, "utf8")).trim();
  } catch {
    /* not a path — fall through to literal */
  }
  return brief;
}

export async function initCommand(video: string, opts: InitOptions): Promise<string> {
  const videoPath = path.resolve(video);
  try {
    await fs.access(videoPath);
  } catch {
    throw new Error(`video not found: ${videoPath}`);
  }

  const name = opts.name || path.basename(videoPath).replace(/\.[^.]+$/, "");
  const projectDir = path.resolve(opts.dir || path.join("projects", name));
  await ensureDir(projectDir);
  await ensureDir(projectPath(projectDir, FILES.audioDir));
  await ensureDir(projectPath(projectDir, FILES.outDir));

  const brief = await resolveBrief(opts.brief);
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    name,
    videoPath,
    brief,
    createdAt: new Date().toISOString(),
  };
  await saveProject(projectDir, project);
  step(`Initialized project "${name}"`);
  ok(`project dir: ${projectDir}`);
  ok(`source video: ${videoPath}`);
  if (!brief) warn("no brief provided (pass --brief <text|file>)");

  if (opts.scaffoldScript) {
    const durationSec = await probeDuration(videoPath);
    const placeholder = "Replace me with the narration for this clip.";
    const timeline: Timeline = {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      durationSec,
      voice: { modelId: "eleven_turbo_v2_5", stability: 0.5, similarityBoost: 0.75 },
      captions: { enabled: false },
      foley: { enabled: true, volume: 1 },
      textOverlays: [],
      sources: [{ id: "src-001", filePath: videoPath, displayName: name }],
      video: [{
        id: "vid-001",
        sourceId: "src-001",
        sourceInSec: 0,
        sourceOutSec: durationSec,
        timelineStartSec: 0,
      }],
      narration: [{
        id: "nar-001",
        startSec: 0,
        narration: placeholder,
        pauseAfterSec: 0,
        estDurationSec: estimateNarrationDurationSec(placeholder),
        audio: null,
      }],
    };
    await saveTimeline(projectDir, timeline);
    ok(`scaffolded ${FILES.timeline} (1 narration clip, ${durationSec.toFixed(1)}s video) — edit it, then run mock-voice + stitch`);
  }

  return projectDir;
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AnalysisSchema,
  ProjectSchema,
  TimelineSchema,
  type Analysis,
  type Project,
  type Timeline,
} from "./types.js";

/** Filenames inside a project directory. The pre-Phase-1.2 legacy
 *  `script.json` / `voice.json` pair was removed in Phase 1.4 along
 *  with its migration helper — every active project was on
 *  `timeline.json` for weeks by then. */
export const FILES = {
  project: "project.json",
  analysis: "analysis.json",
  timeline: "timeline.json",
  audioDir: "audio",
  outDir: "out",
  output: "out/final.mp4",
  // Lightweight 720p proxy of `output`, encoded as a second pass. The
  // in-page player streams this (smooth seeking); `output` stays full-res
  // for download.
  outputPreview: "out/preview.mp4",
} as const;

export function projectPath(projectDir: string, file: string): string {
  return path.join(projectDir, file);
}

async function readJson<S extends z.ZodTypeAny>(
  file: string,
  schema: S,
  label: string,
): Promise<z.infer<S>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`${label} not found at ${file} — run the previous stage first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} at ${file} failed validation:\n${result.error.toString()}`);
  }
  return result.data;
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Public pretty-JSON writer for artifacts without a dedicated saver. */
export const writeJsonArtifact = (file: string, data: unknown) => writeJson(file, data);

export const loadProject = (dir: string) =>
  readJson(projectPath(dir, FILES.project), ProjectSchema, "project.json");
export const saveProject = (dir: string, p: Project) =>
  writeJson(projectPath(dir, FILES.project), p);

export const loadAnalysis = (dir: string): Promise<Analysis> =>
  readJson(projectPath(dir, FILES.analysis), AnalysisSchema, "analysis.json");

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// ── timeline (Phase 1+) ───────────────────────────────────────────────────
// Unified per-project artifact replacing script.json + voice.json. See
// docs/UNIFIED_TIMELINE_PLAN.md. loadTimeline() auto-migrates a legacy
// (script + voice) pair on first call; subsequent calls hit the new file
// directly. The migration renames the originals to *.bak (kept for one
// release as a forensic backup, then removable in Phase 1.4).

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Read `timeline.json`. Throws when the artifact is missing — projects
 *  that pre-date Phase 1.1 were auto-migrated weeks ago; the migration
 *  helper itself was retired in Phase 1.4. If you genuinely have a
 *  script.json / voice.json pair from before the migration shipped, the
 *  pre-1.4 migrateLegacyToTimeline lives in git history. */
export async function loadTimeline(dir: string): Promise<Timeline> {
  return readJson(projectPath(dir, FILES.timeline), TimelineSchema, "timeline.json");
}

export const saveTimeline = (dir: string, t: Timeline) =>
  writeJson(projectPath(dir, FILES.timeline), t);

import { promises as fs } from "node:fs";
import { FILES, projectPath } from "../project.js";
import { initCommand } from "./init.js";
import { analyzeCommand } from "./analyze.js";
import { scriptCommand } from "./script.js";
import { voiceCommand } from "./voice.js";
import { stitchCommand } from "./stitchCommand.js";
import { confirm } from "../prompt.js";
import { info, ok, step, warn } from "../log.js";
import type { Effort } from "../claude.js";

export interface RunCommandOptions {
  brief?: string;
  name?: string;
  dir?: string;
  fps?: number;
  model?: string;
  effort?: Effort;
  voice?: string;
  tolerance?: number;
  out?: string;
  yes?: boolean;
  force?: boolean;
  revoice?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive the whole pipeline: init → analyze → script → (review) → voice → stitch.
 *
 * Resumable: analyze and script are skipped when their artifacts already exist
 * (so hand-edits to script.json survive a re-run); `--force` redoes both. Voice
 * clips already on disk are reused unless `--revoice`. The run pauses for the
 * narration review before the (paid) voice stage whenever the script was
 * (re)generated this run — `--yes` runs fully non-interactive.
 */
export async function runCommand(video: string, opts: RunCommandOptions): Promise<void> {
  // 1. init
  const projectDir = await initCommand(video, {
    brief: opts.brief,
    name: opts.name,
    dir: opts.dir,
  });

  // 2. analyze
  const analysisFile = projectPath(projectDir, FILES.analysis);
  if (opts.force || !(await exists(analysisFile))) {
    await analyzeCommand(projectDir, { fps: opts.fps });
  } else {
    step(`Analyze — using existing ${FILES.analysis} (pass --force to redo)`);
  }

  // 3. script — produces timeline.json with all narration red
  const timelineFile = projectPath(projectDir, FILES.timeline);
  let scriptGenerated = false;
  if (opts.force || !(await exists(timelineFile))) {
    await scriptCommand(projectDir, { model: opts.model, effort: opts.effort, force: true });
    scriptGenerated = true;
  } else {
    step(`Script — using existing ${FILES.timeline} (pass --force to rewrite)`);
  }

  // 4. review checkpoint — gate the paid voiceover behind a look at the narration
  if (scriptGenerated && !opts.yes) {
    info("");
    info(`Review the narration:  ${timelineFile}`);
    info("Edit it now if you'd like — the voiceover bills per character.");
    const proceed = await confirm("Proceed to generate the voiceover?");
    if (!proceed) {
      warn(`Stopped before voiceover. Edit ${FILES.timeline}, then re-run to continue.`);
      return;
    }
  }

  // 5. voice — renders all unrendered narration clips
  await voiceCommand(projectDir, { voice: opts.voice, yes: opts.yes, force: opts.revoice });

  // 6. stitch
  await stitchCommand(projectDir, { out: opts.out });

  info("");
  ok("Pipeline complete.");
}

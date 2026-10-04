import { loadProject, loadTimeline } from "../project.js";
import { stitch } from "../stitch.js";
import { fmtDuration, info, ok, step } from "../log.js";

export interface StitchCommandOptions {
  out?: string;
  /** Forwarded to ffmpeg's progress callback (raw stderr lines). Lets the
   *  HTTP layer stream encode progress so a long stitch doesn't sit silent
   *  behind a proxy that would otherwise time it out. */
  onProgress?: (line: string) => void;
}

export async function stitchCommand(projectDir: string, opts: StitchCommandOptions): Promise<void> {
  const [project, timeline] = await Promise.all([
    loadProject(projectDir),
    loadTimeline(projectDir),
  ]);

  const renderedCount = timeline.narration.filter((n) => n.audio).length;
  step(
    `Stitching "${project.name}" — ${timeline.video.length} video clip(s), ` +
      `${renderedCount}/${timeline.narration.length} narration clip(s) rendered`,
  );

  const result = await stitch({
    projectDir,
    timeline,
    outPath: opts.out,
    onProgress: opts.onProgress ?? (() => {}),
  });

  info("");
  info(
    `  video runtime    : ${fmtDuration(result.videoTotalSec)} (${timeline.video.length} clip(s))`,
  );
  info(
    `  audio bus length : ${fmtDuration(result.finalDurationSec)} (${result.plan.audio.length} placement(s))`,
  );
  if (result.freezeExtendSec > 0.05) {
    info(
      `  freeze extension : ${fmtDuration(result.freezeExtendSec)} (audio runs past video)`,
    );
  }
  ok(`wrote ${result.outPath}`);
}

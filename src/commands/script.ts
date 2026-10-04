import { promises as fs } from "node:fs";
import { FILES, loadAnalysis, loadProject, projectPath, saveTimeline } from "../project.js";
import {
  DEFAULT_MODEL,
  estimateScriptTokens,
  generateScript,
  makeClient,
  type Effort,
} from "../claude.js";
import { buildTimelineFromAnalysis } from "../script-build.js";
import { info, ok, step, warn } from "../log.js";

export interface ScriptCommandOptions {
  apiKey?: string;
  model?: string;
  effort?: Effort;
  force?: boolean;
  dryRun?: boolean;
}

/** Claude Opus 4.7 list price (per 1M tokens). Used only for the dry-run
 *  projection — adjust if you've moved to a different model. */
const PRICE_PER_MTOK = { input: 5, output: 25 } as const;
const fmtUsd = (v: number) => `$${v.toFixed(4)}`;

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function scriptCommand(projectDir: string, opts: ScriptCommandOptions): Promise<void> {
  const timelineFile = projectPath(projectDir, FILES.timeline);
  // Dry-run doesn't write anything, so the overwrite guard doesn't apply.
  if (!opts.dryRun && !opts.force && (await fileExists(timelineFile))) {
    throw new Error(
      "timeline.json already exists — pass --force to regenerate (this discards any manual edits)",
    );
  }

  const [project, analysis] = await Promise.all([loadProject(projectDir), loadAnalysis(projectDir)]);
  const model = opts.model || DEFAULT_MODEL;
  const client = makeClient(opts.apiKey);

  if (opts.dryRun) {
    step(`Estimating script-stage cost for "${project.name}" with ${model}`);
    const { inputTokens } = await estimateScriptTokens({
      client,
      model,
      analysis,
      brief: project.brief,
    });
    // Output projection: narration words ≈ 2.5 × seconds × 1.3 tokens/word.
    // Adaptive thinking adds a variable overhead; bracket it 500..3000 tokens.
    const narrationTokens = Math.round(analysis.durationSec * 2.5 * 1.3);
    const outputLo = narrationTokens + 500;
    const outputHi = narrationTokens + 3000;
    const inputCost = (inputTokens / 1e6) * PRICE_PER_MTOK.input;
    const costLo = inputCost + (outputLo / 1e6) * PRICE_PER_MTOK.output;
    const costHi = inputCost + (outputHi / 1e6) * PRICE_PER_MTOK.output;
    info(`  input tokens        : ${inputTokens.toLocaleString()}  (exact, from /count_tokens)`);
    info(`  output tokens (est.): ${outputLo.toLocaleString()} – ${outputHi.toLocaleString()}  (narration + adaptive thinking)`);
    info(`  est. cost           : ${fmtUsd(costLo)} – ${fmtUsd(costHi)}  (Opus 4.7 list price: $${PRICE_PER_MTOK.input}/M in, $${PRICE_PER_MTOK.output}/M out)`);
    ok("dry run — no script generated, timeline.json left untouched");
    return;
  }

  step(`Writing script for "${project.name}" with ${model} (${analysis.segments.length} segment(s))`);
  const { draft, usage } = await generateScript({
    client,
    model,
    analysis,
    brief: project.brief,
    effort: opts.effort,
  });

  const { timeline, missing, extra } = buildTimelineFromAnalysis(project, analysis, draft);
  if (missing.length) warn(`${missing.length} segment(s) got no narration: ${missing.join(", ")}`);
  if (extra.length) warn(`Claude returned ${extra.length} unknown segment id(s), ignored: ${extra.join(", ")}`);

  await saveTimeline(projectDir, timeline);
  const words = timeline.narration.reduce((n, s) => n + countWords(s.narration), 0);
  ok(`wrote ${FILES.timeline} (${timeline.narration.length} narration clip(s), ${words} words)`);

  const u = usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cache = [
    u.cache_read_input_tokens ? `cache-read ${u.cache_read_input_tokens}` : "",
    u.cache_creation_input_tokens ? `cache-write ${u.cache_creation_input_tokens}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  info(`  tokens — input ${u.input_tokens}, output ${u.output_tokens}${cache ? `, ${cache}` : ""}`);
  warn(`review/edit ${FILES.timeline} before voicing`);
}

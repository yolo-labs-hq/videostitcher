import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Analysis, AnalysisSegment } from "./types.js";

/** Opus 4.7 — most capable; adaptive thinking only (see the claude-api skill). */
export const DEFAULT_MODEL = "claude-opus-4-7";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The structured output we ask Claude for: narration keyed back to the
 *  analysis segment ids. Timing stays authoritative from the analysis — Claude
 *  only writes prose, so this shape deliberately omits start/end. */
export const ScriptDraftSchema = z.object({
  segments: z.array(
    z.object({
      id: z.string().describe("The segment id from the analysis, copied verbatim"),
      narration: z.string().describe("Spoken voiceover narration for this segment"),
      pauseAfterSec: z
        .number()
        .describe("Seconds of deliberate pause after this segment's narration; 0 if none"),
    }),
  ),
});
export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

/** Build an SDK client. Honors ANTHROPIC_BASE_URL (used for local testing). */
export function makeClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.VIDEOSTITCHER_ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("no Anthropic API key — set VIDEOSTITCHER_ANTHROPIC_API_KEY (or pass --api-key)");
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return new Anthropic({ apiKey: key, ...(baseURL ? { baseURL } : {}) });
}

// Static across all projects → caches across runs (cache_control on the block).
const SYSTEM_PROMPT = [
  "You are a professional voiceover scriptwriter for software screencasts and product demos.",
  "You turn a timestamped visual analysis of a screen recording into natural, engaging narration",
  "that a voice actor will read aloud over the video.",
  "",
  "Principles:",
  "- Write conversational spoken English — short sentences, active voice, contractions. It will be heard, not read.",
  "- Narrate what matters and why; don't just describe pixels. Avoid meta phrases like 'in this segment',",
  "  'as you can see', or 'the screen shows'.",
  "- It is one continuous narration, not isolated blurbs — keep continuity across segments and vary sentence openings.",
  "- Respect timing: each segment has startSec/endSec. Spoken English runs ~2.5 words/second, so aim for roughly",
  "  2.5 × (endSec − startSec) words per segment. Running modestly over is fine (the video can hold a frame), but",
  "  never pad to fill time — concise wins.",
  "- Use the operator's brief as the source of truth for product names, intent, and tone.",
  "- Set pauseAfterSec when a brief beat helps (e.g. before a topic shift); otherwise 0.",
  "- Provide narration for every segment id, exactly once, with ids copied verbatim from the analysis.",
].join("\n");

const WRITE_INSTRUCTION =
  "Write the voiceover narration now. Return one entry per analysis segment, using the exact segment ids.";

export interface GenerateResult {
  draft: ScriptDraft;
  usage: Anthropic.Usage;
  stopReason: string | null;
}

/** The exact `system` + `messages` we'd send. Factored out so dry-run token
 *  counting hits the same bytes as the real call. */
function buildScriptPrompt(
  analysis: Analysis,
  brief: string,
): Pick<Anthropic.MessageCreateParams, "system" | "messages"> {
  const analysisForModel = { durationSec: analysis.durationSec, segments: analysis.segments };
  const analysisJson = JSON.stringify(analysisForModel, null, 2);
  return {
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Recording brief from the operator:\n${brief || "(no brief provided)"}` },
          {
            type: "text",
            text: `Per-segment video analysis (timestamps are seconds):\n${analysisJson}`,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: WRITE_INSTRUCTION },
        ],
      },
    ],
  };
}

/** Free, authenticated call to /v1/messages/count_tokens — the exact input
 *  token count for the prompt the script stage would send. */
export async function estimateScriptTokens(opts: {
  client: Anthropic;
  model: string;
  analysis: Analysis;
  brief: string;
}): Promise<{ inputTokens: number }> {
  const { system, messages } = buildScriptPrompt(opts.analysis, opts.brief);
  const res = await opts.client.messages.countTokens({ model: opts.model, system, messages });
  return { inputTokens: res.input_tokens };
}

/**
 * Generate a narration draft from the analysis + brief. Uses Opus 4.7 with
 * adaptive thinking and a Zod-validated structured output. The system prompt
 * and analysis are marked cacheable so re-runs of the same project are cheap.
 */
export async function generateScript(opts: {
  client: Anthropic;
  model: string;
  analysis: Analysis;
  brief: string;
  effort?: Effort;
}): Promise<GenerateResult> {
  const { system, messages } = buildScriptPrompt(opts.analysis, opts.brief);
  const message = await opts.client.messages.parse({
    model: opts.model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(ScriptDraftSchema), effort: opts.effort ?? "high" },
    system,
    messages,
  });

  if (message.stop_reason === "refusal") {
    throw new Error("Claude refused to write the script");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens before finishing — raise max_tokens or shorten the analysis");
  }
  const draft = message.parsed_output;
  if (!draft) {
    throw new Error("Claude did not return a parseable script");
  }
  return { draft, usage: message.usage, stopReason: message.stop_reason };
}

// ── "Help me write" — per-clip narration assist ─────────────────────────────
//
// Two modes the operator can ask for while editing a single narration clip:
//   - 'improve': rewrite/tighten the text they've already written.
//   - 'prompt' : draft fresh narration from a free-text instruction.
// Both fold in optional sceneContext (a compact summary of what's on screen
// during the clip's time window, derived from the Gemini analysis) and
// neighborContext (the surrounding clips' narration) when available, so the
// suggestion matches the visuals and flows with the lines around it. When no
// analysis exists the call simply operates text-only.

export type HelpMode = "improve" | "prompt";

/** The structured suggestion we ask Claude for: one primary narration line
 *  plus an optional one-line rationale. Deliberately a single suggestion —
 *  no variant fan-out. */
export const NarrationSuggestionSchema = z.object({
  narration: z.string().describe("The suggested spoken voiceover narration for this clip"),
  note: z
    .string()
    .optional()
    .describe("One short line explaining the rationale for the change; omit if obvious"),
});
export type NarrationSuggestion = z.infer<typeof NarrationSuggestionSchema>;

// Same voiceover voice as generateScript's SYSTEM_PROMPT, scoped to a single
// clip rather than a whole timeline.
const HELP_SYSTEM_PROMPT = [
  "You are a professional voiceover scriptwriter for software screencasts and product demos.",
  "You help an operator polish or draft the spoken narration for ONE clip in a larger video.",
  "",
  "Principles:",
  "- Write conversational spoken English — short sentences, active voice, contractions. It will be heard, not read.",
  "- Narrate what matters and why; don't just describe pixels. Avoid meta phrases like 'in this segment',",
  "  'as you can see', or 'the screen shows'.",
  "- This is one line within a continuous narration — make it flow with the surrounding lines and vary sentence openings.",
  "- Keep it concise: roughly one or two spoken sentences for a single clip unless the operator asks for more.",
  "- When on-screen context is provided, make the wording match what's actually visible.",
  "- Return ONLY the narration text itself — no quotes, no labels, no stage directions.",
].join("\n");

/** Trim and collapse a possibly-multiline scene field into a single tidy line.
 *  Returns "" for nullish/blank input so callers can filter. */
function tidy(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Pure helper: summarize the analysis segment(s) overlapping a clip's time
 * window [startSec, endSec) into a compact, model-friendly string. Returns
 * `undefined` when there's no analysis or no overlapping segment, so the
 * caller can cleanly fall back to text-only. Exported for unit testing.
 *
 * Overlap rule: a segment overlaps the window when seg.startSec < endSec and
 * seg.endSec > startSec. When `endSec` is omitted, only the segment containing
 * `startSec` (or the next one starting after it) is considered — a clip with
 * no known duration still gets the on-screen context at its in-point.
 */
export function deriveSceneContext(
  analysis: Analysis | null | undefined,
  startSec: number,
  endSec?: number,
): string | undefined {
  if (!analysis || !Array.isArray(analysis.segments) || analysis.segments.length === 0) {
    return undefined;
  }
  const hi = typeof endSec === "number" && endSec > startSec ? endSec : startSec;
  let overlapping: AnalysisSegment[];
  if (hi > startSec) {
    overlapping = analysis.segments.filter((s) => s.startSec < hi && s.endSec > startSec);
  } else {
    // Zero-width window (no duration): the segment that contains startSec.
    overlapping = analysis.segments.filter((s) => s.startSec <= startSec && s.endSec > startSec);
    if (overlapping.length === 0) {
      // Nothing contains it (e.g. startSec past the last segment) → nearest by start.
      const sorted = [...analysis.segments].sort(
        (a, b) => Math.abs(a.startSec - startSec) - Math.abs(b.startSec - startSec),
      );
      if (sorted[0]) overlapping = [sorted[0]];
    }
  }
  if (overlapping.length === 0) return undefined;

  const lines: string[] = [];
  for (const seg of overlapping) {
    const parts: string[] = [];
    const summary = tidy(seg.visualSummary);
    if (summary) parts.push(summary);
    const action = tidy(seg.keyAction);
    if (action) parts.push(`Action: ${action}`);
    const onScreen = (seg.onScreenText ?? []).map(tidy).filter(Boolean);
    if (onScreen.length) parts.push(`On-screen text: ${onScreen.join(" | ")}`);
    const beat = tidy(seg.suggestedBeat);
    if (beat) parts.push(`Suggested beat: ${beat}`);
    if (parts.length === 0) continue;
    lines.push(`[${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s] ${parts.join(". ")}`);
  }
  const joined = lines.join("\n");
  return joined.length ? joined : undefined;
}

export interface NeighborContext {
  /** Narration text of the immediately preceding clip (by startSec). */
  prev?: string;
  /** Narration text of the immediately following clip (by startSec). */
  next?: string;
}

/** Build the `system` + `messages` for a help-me-write call. Factored out so
 *  it can be unit-tested without an API call. Pure. */
export function buildHelpPrompt(opts: {
  mode: HelpMode;
  currentText?: string;
  prompt?: string;
  sceneContext?: string;
  neighborContext?: NeighborContext;
}): Pick<Anthropic.MessageCreateParams, "system" | "messages"> {
  const blocks: Anthropic.TextBlockParam[] = [];

  const scene = tidy(opts.sceneContext);
  if (scene) {
    blocks.push({
      type: "text",
      text: `What's on screen during this clip (from the video analysis):\n${opts.sceneContext}`,
    });
  } else {
    blocks.push({
      type: "text",
      text: "No on-screen analysis is available for this clip — work from the text alone.",
    });
  }

  const prev = tidy(opts.neighborContext?.prev);
  const next = tidy(opts.neighborContext?.next);
  if (prev || next) {
    const surround = [
      prev ? `Previous clip's narration: ${prev}` : "",
      next ? `Next clip's narration: ${next}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    blocks.push({
      type: "text",
      text: `Surrounding narration (for flow — do NOT repeat these lines):\n${surround}`,
    });
  }

  if (opts.mode === "improve") {
    const current = (opts.currentText ?? "").trim();
    blocks.push({
      type: "text",
      text:
        `Improve the narration for this clip. Tighten it, make it conversational and active, ` +
        `and match screencast voiceover conventions, while preserving its meaning and intent.\n\n` +
        `Current narration:\n${current || "(empty)"}`,
    });
  } else {
    const instruction = (opts.prompt ?? "").trim();
    const current = (opts.currentText ?? "").trim();
    blocks.push({
      type: "text",
      text:
        `Draft fresh narration for this clip based on this instruction from the operator:\n` +
        `${instruction || "(no instruction provided — write fitting narration from the on-screen context)"}` +
        (current ? `\n\nExisting draft to consider (may be replaced):\n${current}` : ""),
    });
  }

  return {
    system: [{ type: "text", text: HELP_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: blocks }],
  };
}

export interface HelpWriteResult {
  narration: string;
  note?: string;
}

/**
 * "Help me write" — produce one improved/drafted narration line for a single
 * clip. Uses the same Anthropic SDK client setup, model (Opus 4.7), adaptive
 * thinking, and Zod-validated structured output as generateScript.
 */
export async function helpWriteNarration(opts: {
  mode: HelpMode;
  currentText?: string;
  prompt?: string;
  sceneContext?: string;
  neighborContext?: NeighborContext;
  apiKey?: string;
  client?: Anthropic;
  model?: string;
  effort?: Effort;
}): Promise<HelpWriteResult> {
  if (opts.mode !== "improve" && opts.mode !== "prompt") {
    throw new Error(`unknown mode: ${String(opts.mode)} — expected 'improve' or 'prompt'`);
  }
  if (opts.mode === "improve" && !(opts.currentText ?? "").trim()) {
    throw new Error("improve mode needs the current narration text");
  }
  if (opts.mode === "prompt" && !(opts.prompt ?? "").trim() && !tidy(opts.sceneContext)) {
    throw new Error("prompt mode needs a prompt (or scene context to draft from)");
  }

  const client = opts.client ?? makeClient(opts.apiKey);
  const model = opts.model || DEFAULT_MODEL;
  const { system, messages } = buildHelpPrompt(opts);

  const message = await client.messages.parse({
    model,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(NarrationSuggestionSchema), effort: opts.effort ?? "medium" },
    system,
    messages,
  });

  if (message.stop_reason === "refusal") {
    throw new Error("Claude refused to write the narration");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens before finishing — try a shorter prompt");
  }
  const out = message.parsed_output;
  if (!out || !out.narration.trim()) {
    throw new Error("Claude did not return a usable narration");
  }
  return { narration: out.narration.trim(), ...(out.note?.trim() ? { note: out.note.trim() } : {}) };
}

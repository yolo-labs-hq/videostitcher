import { createHash } from "node:crypto";

/**
 * Hash of a narration string used to detect "edit invalidates audio" drift.
 * Normalises whitespace (trim + collapse internal runs) so cosmetic edits —
 * adding a trailing newline, double-spacing after a period — do NOT
 * invalidate a previously-rendered audio clip. Anything that would change
 * what ElevenLabs actually says (different word, different punctuation
 * that affects prosody) MUST change the hash.
 *
 * Format: `sha256:<hex>`. The prefix lets future code switch algorithms
 * without ambiguity.
 */
export function narrationHash(text: string): string {
  const normalised = text.replace(/\s+/g, " ").trim();
  return "sha256:" + createHash("sha256").update(normalised).digest("hex");
}

/** Estimated spoken duration of a narration line. Used for visual width
 *  of red (unrendered) clips on the audio track. Matches mockVoice's
 *  defaults so a mock-voice run and the pre-render estimate are
 *  comparable. */
export const ESTIMATE_WORDS_PER_SEC = 2.6;
export const ESTIMATE_MIN_SEC = 0.8;

export function estimateNarrationDurationSec(
  text: string,
  wordsPerSec = ESTIMATE_WORDS_PER_SEC,
  minSec = ESTIMATE_MIN_SEC,
): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.max(minSec, words / wordsPerSec);
}

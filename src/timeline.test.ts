import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateNarrationDurationSec, narrationHash } from "./narrationHash.js";

// The Phase 1.1 migration tests (migrateLegacyToTimeline +
// timelineToScript/Voice + applyScript/VoiceToTimeline) were removed in
// Phase 1.4 along with the helpers themselves. The narrationHash +
// estimate functions stay — they're load-bearing for "edit
// invalidates audio" (hash) and red-clip width during composition
// (estimate).

test("narrationHash is stable across cosmetic whitespace edits", () => {
  const base = narrationHash("Hello world.");
  assert.equal(narrationHash("  Hello world.  "), base);
  assert.equal(narrationHash("Hello\nworld."), base);
  assert.equal(narrationHash("Hello\t world."), base);
});

test("narrationHash changes when actual words change", () => {
  const a = narrationHash("Hello world.");
  const b = narrationHash("Hello worlds.");
  assert.notEqual(a, b);
});

test("narrationHash distinguishes punctuation changes (prosody-sensitive)", () => {
  assert.notEqual(narrationHash("Now go."), narrationHash("Now, go."));
});

test("estimateNarrationDurationSec floors short lines at minSec", () => {
  // One short word would estimate 1/2.6 ≈ 0.38s; the floor is 0.8s.
  assert.equal(estimateNarrationDurationSec("Hi."), 0.8);
});

test("estimateNarrationDurationSec scales with word count", () => {
  const ten = estimateNarrationDurationSec("one two three four five six seven eight nine ten");
  assert.ok(ten > 3 && ten < 4); // ~3.85s
});

test("estimateNarrationDurationSec returns 0 for empty text", () => {
  assert.equal(estimateNarrationDurationSec("   "), 0);
});

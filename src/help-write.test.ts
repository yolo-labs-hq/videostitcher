import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSceneContext, buildHelpPrompt } from "./claude.js";
import type { Analysis } from "./types.js";

function analysis(): Analysis {
  return {
    schemaVersion: 1,
    durationSec: 30,
    segments: [
      {
        id: "seg-001",
        startSec: 0,
        endSec: 10,
        visualSummary: "The settings page opens",
        keyAction: "click Save",
        onScreenText: ["Settings", "Saved"],
        suggestedBeat: "intro",
      },
      {
        id: "seg-002",
        startSec: 10,
        endSec: 20,
        visualSummary: "A dialog appears",
      },
      { id: "seg-003", startSec: 20, endSec: 30, visualSummary: "Done" },
    ],
  };
}

test("deriveSceneContext summarizes the overlapping segment", () => {
  const ctx = deriveSceneContext(analysis(), 2, 8);
  assert.ok(ctx, "expected a context string");
  assert.match(ctx!, /settings page opens/i);
  assert.match(ctx!, /Action: click Save/);
  assert.match(ctx!, /On-screen text: Settings \| Saved/);
  assert.match(ctx!, /Suggested beat: intro/);
  // single overlapping segment → single line
  assert.equal(ctx!.split("\n").length, 1);
});

test("deriveSceneContext folds in multiple overlapping segments", () => {
  const ctx = deriveSceneContext(analysis(), 8, 15);
  assert.ok(ctx);
  assert.equal(ctx!.split("\n").length, 2);
  assert.match(ctx!, /settings page opens/i);
  assert.match(ctx!, /A dialog appears/i);
});

test("deriveSceneContext with no endSec uses the segment containing startSec", () => {
  const ctx = deriveSceneContext(analysis(), 12);
  assert.ok(ctx);
  assert.match(ctx!, /A dialog appears/i);
  assert.doesNotMatch(ctx!, /settings page opens/i);
});

test("deriveSceneContext returns undefined when analysis is absent", () => {
  assert.equal(deriveSceneContext(null, 5, 10), undefined);
  assert.equal(deriveSceneContext(undefined, 5, 10), undefined);
});

test("deriveSceneContext returns undefined when a segment has no usable fields", () => {
  const a: Analysis = {
    schemaVersion: 1,
    durationSec: 10,
    segments: [{ id: "x", startSec: 0, endSec: 10 }],
  };
  assert.equal(deriveSceneContext(a, 1, 5), undefined);
});

test("buildHelpPrompt(improve) includes current text and scene context", () => {
  const { messages } = buildHelpPrompt({
    mode: "improve",
    currentText: "click the button to save",
    sceneContext: "[0–10s] The settings page opens",
    neighborContext: { prev: "Welcome back.", next: "Now let's continue." },
  });
  const text = JSON.stringify(messages);
  assert.match(text, /click the button to save/);
  assert.match(text, /Improve the narration/);
  assert.match(text, /The settings page opens/);
  assert.match(text, /Welcome back\./);
  assert.match(text, /Now let's continue\./);
});

test("buildHelpPrompt(prompt) includes the instruction and notes no analysis when absent", () => {
  const { messages } = buildHelpPrompt({
    mode: "prompt",
    prompt: "explain how to enable dark mode",
  });
  const text = JSON.stringify(messages);
  assert.match(text, /explain how to enable dark mode/);
  assert.match(text, /Draft fresh narration/);
  assert.match(text, /No on-screen analysis is available/);
});

test("buildHelpPrompt omits neighbor block when there are no neighbors", () => {
  const { messages } = buildHelpPrompt({ mode: "improve", currentText: "hello" });
  const text = JSON.stringify(messages);
  assert.doesNotMatch(text, /Surrounding narration/);
});

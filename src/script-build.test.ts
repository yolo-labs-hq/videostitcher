import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineFromAnalysis } from "./script-build.js";
import type { Analysis, Project } from "./types.js";
import type { ScriptDraft } from "./claude.js";

const PROJECT: Project = {
  schemaVersion: 1,
  name: "demo",
  videoPath: "/tmp/in.mp4",
  brief: "",
  createdAt: "2026-05-27T00:00:00Z",
};

function analysis(): Analysis {
  return {
    schemaVersion: 1,
    durationSec: 20,
    segments: [
      { id: "seg-001", startSec: 0, endSec: 6,  visualSummary: "a" },
      { id: "seg-002", startSec: 6, endSec: 12, visualSummary: "b" },
    ],
  };
}

test("draft becomes narration[] anchored at analysis startSec, all red", () => {
  const draft: ScriptDraft = {
    segments: [
      { id: "seg-002", narration: "second", pauseAfterSec: 0 },
      { id: "seg-001", narration: "  first  ", pauseAfterSec: 1.5 },
    ],
  };
  const { timeline, missing, extra } = buildTimelineFromAnalysis(PROJECT, analysis(), draft);
  assert.equal(missing.length, 0);
  assert.equal(extra.length, 0);
  // narration order follows analysis, not the draft
  assert.deepEqual(
    timeline.narration.map((n) => [n.id, n.startSec, n.narration, n.pauseAfterSec]),
    [
      ["seg-001", 0, "first", 1.5], // trimmed
      ["seg-002", 6, "second", 0],
    ],
  );
  // every clip starts red
  assert.ok(timeline.narration.every((n) => n.audio === null));
  // estimated duration > 0 for non-empty narration
  assert.ok(timeline.narration.every((n) => n.estDurationSec > 0));
});

test("missing draft entries become silent (empty narration + zero estimate)", () => {
  const draft: ScriptDraft = {
    segments: [{ id: "seg-001", narration: "only one", pauseAfterSec: 0 }],
  };
  const { timeline, missing } = buildTimelineFromAnalysis(PROJECT, analysis(), draft);
  assert.deepEqual(missing, ["seg-002"]);
  assert.equal(timeline.narration[1]!.narration, "");
  assert.equal(timeline.narration[1]!.estDurationSec, 0);
});

test("ids Claude invented are surfaced as `extra` and dropped", () => {
  const draft: ScriptDraft = {
    segments: [
      { id: "seg-001", narration: "a", pauseAfterSec: 0 },
      { id: "seg-002", narration: "b", pauseAfterSec: 0 },
      { id: "seg-999", narration: "hallucinated", pauseAfterSec: 0 },
    ],
  };
  const { timeline, extra } = buildTimelineFromAnalysis(PROJECT, analysis(), draft);
  assert.deepEqual(extra, ["seg-999"]);
  assert.equal(timeline.narration.length, 2);
});

test("negative pauseAfterSec clamps to zero", () => {
  const draft: ScriptDraft = {
    segments: [
      { id: "seg-001", narration: "a", pauseAfterSec: -3 },
      { id: "seg-002", narration: "b", pauseAfterSec: 0 },
    ],
  };
  const { timeline } = buildTimelineFromAnalysis(PROJECT, analysis(), draft);
  assert.equal(timeline.narration[0]!.pauseAfterSec, 0);
});

test("source + video clip wrap the single project.videoPath", () => {
  const draft: ScriptDraft = { segments: [] };
  const { timeline } = buildTimelineFromAnalysis(PROJECT, analysis(), draft);
  assert.equal(timeline.sources.length, 1);
  assert.equal(timeline.sources[0]!.filePath, "/tmp/in.mp4");
  assert.equal(timeline.video.length, 1);
  assert.equal(timeline.video[0]!.sourceInSec, 0);
  assert.equal(timeline.video[0]!.sourceOutSec, 20);
});

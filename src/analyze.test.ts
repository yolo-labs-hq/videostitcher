import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnalysisSegments } from "./commands/analyze.js";

test("assigns sequential ids and sorts by start", () => {
  const out = normalizeAnalysisSegments(
    [
      { startSec: 5, endSec: 10, visualSummary: "b" },
      { startSec: 0, endSec: 5, visualSummary: "a" },
    ],
    10,
  );
  assert.deepEqual(
    out.map((s) => [s.id, s.startSec, s.visualSummary]),
    [
      ["seg-001", 0, "a"],
      ["seg-002", 5, "b"],
    ],
  );
});

test("clamps endSec to the real duration", () => {
  const out = normalizeAnalysisSegments([{ startSec: 8, endSec: 99, visualSummary: "x" }], 10);
  assert.equal(out[0]!.endSec, 10);
});

test("repairs overlap by pulling the later start forward", () => {
  const out = normalizeAnalysisSegments(
    [
      { startSec: 0, endSec: 6, visualSummary: "a" },
      { startSec: 5, endSec: 9, visualSummary: "b" },
    ],
    9,
  );
  assert.equal(out[0]!.endSec, 6);
  assert.equal(out[1]!.startSec, 6); // pulled forward from 5
  assert.equal(out[1]!.endSec, 9);
});

test("drops segments that collapse to zero length after repair", () => {
  const out = normalizeAnalysisSegments(
    [
      { startSec: 0, endSec: 6, visualSummary: "a" },
      { startSec: 4, endSec: 6, visualSummary: "swallowed" }, // fully inside prev
    ],
    6,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.visualSummary, "a");
});

test("ignores entries missing numeric timestamps", () => {
  const out = normalizeAnalysisSegments(
    [
      { startSec: 0, endSec: 5, visualSummary: "ok" },
      { visualSummary: "no timestamps" } as never,
    ],
    5,
  );
  assert.equal(out.length, 1);
});

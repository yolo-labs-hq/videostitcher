import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FOLEY_SAMPLE_RATE,
  FoleySidecarSchema,
  remapFoleyEvents,
  renderFoleyWav,
  sidecarPathFor,
  type FoleySidecar,
  type PlacedFoleyEvent,
} from "./foley.js";
import { TimelineSchema, type Timeline } from "./types.js";

// ── helpers ───────────────────────────────────────────────────────────────

/** Minimal valid timeline with one source + supplied clips. */
function tl(clips: Array<Partial<Timeline["video"][number]>>): Timeline {
  return TimelineSchema.parse({
    durationSec: 100,
    sources: [{ id: "src-001", filePath: "take.mp4" }],
    video: clips.map((c, i) => ({
      id: `clip-${i}`,
      sourceId: "src-001",
      sourceInSec: 0,
      sourceOutSec: 10,
      timelineStartSec: 0,
      ...c,
    })),
    narration: [],
  });
}

/** Sidecar with firstFrameTs=0 so srcSec == ts/1000 (easy math). */
function sidecar(events: FoleySidecar["events"]): Map<string, FoleySidecar> {
  return new Map([["src-001", FoleySidecarSchema.parse({ version: 1, firstFrameTs: 0, events })]]);
}

// ── sidecar schema ────────────────────────────────────────────────────────

test("sidecar schema accepts the driver's shape (extra fields tolerated)", () => {
  const parsed = FoleySidecarSchema.parse({
    version: 1,
    startedAt: 1781199027111,
    stoppedAt: 1781199281539,
    firstFrameTs: 1781199027300,
    events: [
      { type: "click", ts: 1781199030000 },
      { type: "click", ts: 1781199031000, count: 2 },
      { type: "key", ts: 1781199032000, key: "Enter" },
      { type: "key", ts: 1781199032100 },
    ],
  });
  assert.equal(parsed.events.length, 4);
});

test("sidecarPathFor swaps the extension", () => {
  assert.equal(sidecarPathFor("/a/b/rough-cut.mp4"), "/a/b/rough-cut.inputs.json");
  assert.equal(sidecarPathFor("/a/b/noext"), "/a/b/noext.inputs.json");
});

// ── remap ─────────────────────────────────────────────────────────────────

test("remap: events inside the trim map linearly, outside are dropped", () => {
  const timeline = tl([{ sourceInSec: 2, sourceOutSec: 8, timelineStartSec: 0 }]);
  const events = remapFoleyEvents(
    timeline,
    sidecar([
      { type: "click", ts: 1000 }, // 1s — before trim → dropped
      { type: "click", ts: 3000 }, // 3s → output 1s
      { type: "key", ts: 7999 }, // 7.999s → output 5.999s
      { type: "key", ts: 8000 }, // exactly at out-point → dropped (half-open)
    ]),
  );
  assert.equal(events.length, 2);
  assert.ok(Math.abs(events[0].atSec - 1) < 1e-9);
  assert.ok(Math.abs(events[1].atSec - 5.999) < 1e-9);
});

test("remap: speed compresses event spacing", () => {
  const timeline = tl([{ sourceInSec: 0, sourceOutSec: 10, timelineStartSec: 0, speed: 2 }]);
  const events = remapFoleyEvents(timeline, sidecar([{ type: "click", ts: 6000 }]));
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].atSec - 3) < 1e-9, `6s source at 2x → 3s output, got ${events[0].atSec}`);
});

test("remap: later clips offset by their timeline start", () => {
  const timeline = tl([
    { id: "a", sourceInSec: 0, sourceOutSec: 5, timelineStartSec: 0 },
    { id: "b", sourceInSec: 20, sourceOutSec: 30, timelineStartSec: 5 },
  ]);
  const events = remapFoleyEvents(
    timeline,
    sidecar([
      { type: "click", ts: 25000 }, // 25s source → clip b → output 5 + 5 = 10
      { type: "key", ts: 1000 }, // 1s source → clip a → output 1
    ]),
  );
  assert.equal(events.length, 2);
  // Sorted by output time: key at 1s first, click at 10s second.
  assert.ok(Math.abs(events[0].atSec - 1) < 1e-9);
  assert.equal(events[0].kind, "key");
  assert.ok(Math.abs(events[1].atSec - 10) < 1e-9);
  assert.equal(events[1].kind, "click");
});

test("remap: kind classification + click count cap", () => {
  const timeline = tl([{}]);
  const events = remapFoleyEvents(
    timeline,
    sidecar([
      { type: "click", ts: 1000, count: 99 },
      { type: "key", ts: 2000, key: "Space" },
      { type: "key", ts: 3000, key: "Enter" },
      { type: "key", ts: 4000, key: "Tab" },
    ]),
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.count]),
    [
      ["click", 3], // capped at 3
      ["key-space", 1],
      ["key-enter", 1],
      ["key", 1], // named-but-unmapped key falls back to generic
    ],
  );
});

test("remap: sources without a sidecar produce nothing", () => {
  const timeline = tl([{}]);
  assert.deepEqual(remapFoleyEvents(timeline, new Map()), []);
});

// ── WAV render ────────────────────────────────────────────────────────────

async function readWav(file: string): Promise<{ sampleRate: number; samples: Int16Array }> {
  const buf = await fs.readFile(file);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  const sampleRate = buf.readUInt32LE(24);
  const dataLen = buf.readUInt32LE(40);
  const samples = new Int16Array(dataLen / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(44 + i * 2);
  return { sampleRate, samples };
}

const rms = (s: Int16Array, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to && i < s.length; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

test("renderFoleyWav: sound lands at event offsets, silence elsewhere", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foley-test-"));
  const out = path.join(dir, "foley.wav");
  const events: PlacedFoleyEvent[] = [
    { atSec: 1, kind: "click", count: 1 },
    { atSec: 3, kind: "key", count: 1 },
  ];
  const res = await renderFoleyWav(events, out, { totalDurationSec: 5 });
  assert.equal(res.eventCount, 2);
  const { sampleRate, samples } = await readWav(out);
  assert.equal(sampleRate, FOLEY_SAMPLE_RATE);
  assert.equal(samples.length, 5 * FOLEY_SAMPLE_RATE, "clamped exactly to totalDurationSec");
  const sr = FOLEY_SAMPLE_RATE;
  assert.ok(rms(samples, 1 * sr, 1 * sr + sr / 10) > 100, "click audible at 1s");
  assert.ok(rms(samples, 3 * sr, 3 * sr + sr / 10) > 50, "key tick audible at 3s");
  assert.equal(rms(samples, 2 * sr, 2.5 * sr), 0, "silence between events");
  assert.equal(rms(samples, 4 * sr, 5 * sr), 0, "silence after events");
  await fs.rm(dir, { recursive: true, force: true });
});

test("renderFoleyWav: double-click renders two transients; render is deterministic", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foley-test-"));
  const out1 = path.join(dir, "a.wav");
  const out2 = path.join(dir, "b.wav");
  const events: PlacedFoleyEvent[] = [{ atSec: 0.5, kind: "click", count: 2 }];
  await renderFoleyWav(events, out1, { totalDurationSec: 2 });
  await renderFoleyWav(events, out2, { totalDurationSec: 2 });
  const a = await fs.readFile(out1);
  const b = await fs.readFile(out2);
  assert.ok(a.equals(b), "same events render byte-identically");
  const { samples } = await readWav(out1);
  const sr = FOLEY_SAMPLE_RATE;
  // Second click of the pair lands 0.12s after the first.
  assert.ok(rms(samples, Math.round(0.62 * sr), Math.round(0.64 * sr)) > 50, "second click audible at +120ms");
  await fs.rm(dir, { recursive: true, force: true });
});

test("renderFoleyWav: events past the clamp are skipped, volume scales output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foley-test-"));
  const outLoud = path.join(dir, "loud.wav");
  const outQuiet = path.join(dir, "quiet.wav");
  const events: PlacedFoleyEvent[] = [
    { atSec: 0.5, kind: "key-enter", count: 1 },
    { atSec: 99, kind: "click", count: 1 }, // beyond totalDurationSec — skipped
  ];
  await renderFoleyWav(events, outLoud, { totalDurationSec: 2, volume: 1 });
  await renderFoleyWav(events, outQuiet, { totalDurationSec: 2, volume: 0.5 });
  const loud = await readWav(outLoud);
  const quiet = await readWav(outQuiet);
  const sr = FOLEY_SAMPLE_RATE;
  const lr = rms(loud.samples, Math.round(0.5 * sr), Math.round(0.6 * sr));
  const qr = rms(quiet.samples, Math.round(0.5 * sr), Math.round(0.6 * sr));
  assert.ok(lr > 0 && qr > 0);
  assert.ok(Math.abs(qr / lr - 0.5) < 0.05, `volume 0.5 halves rms (got ratio ${(qr / lr).toFixed(3)})`);
  assert.equal(loud.samples.length, 2 * FOLEY_SAMPLE_RATE);
  await fs.rm(dir, { recursive: true, force: true });
});

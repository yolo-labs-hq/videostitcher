import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { planTimeline } from "./timing.js";
import { buildFilterGraph, ffmpegColor } from "./stitch.js";
import { TIMELINE_SCHEMA_VERSION, type Timeline } from "./types.js";

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

const VOICE = { modelId: "x", stability: 0.5, similarityBoost: 0.75 } as const;
const PROJ = "/tmp/proj";

function timeline(opts: {
  durationSec: number;
  video?: Array<{ in: number; out: number; sourceId?: string; speed?: number; track?: number }>;
  sources?: Array<{ id: string; filePath: string }>;
  narration?: Array<{ id: string; startSec: number; audio?: { dur: number }; narration?: string; estDurationSec?: number; audioInSec?: number; audioOutSec?: number; track?: number }>;
  captionsEnabled?: boolean;
  textOverlays?: Timeline["textOverlays"];
  audioLanes?: Timeline["audioLanes"];
}): Timeline {
  const sources = opts.sources ?? [
    { id: "src-001", filePath: "input.mp4" },
  ];
  const videoClips = (opts.video ?? [{ in: 0, out: opts.durationSec }]).map((v, i) => {
    return {
      id: `vid-${String(i + 1).padStart(3, "0")}`,
      sourceId: v.sourceId ?? sources[0]!.id,
      sourceInSec: v.in,
      sourceOutSec: v.out,
      timelineStartSec: 0, // overwritten below
      ...(v.speed != null ? { speed: v.speed } : {}),
      ...(v.track != null ? { track: v.track } : {}),
    };
  });
  // Snap timelineStartSec to back-to-back PER LANE so the planner's per-lane
  // invariant doesn't trip on fixtures. Effective dur honors speed.
  const laneCursors = new Map<number, number>();
  for (const c of videoClips) {
    const t = (c as { track?: number }).track ?? 0;
    const cursor = laneCursors.get(t) ?? 0;
    c.timelineStartSec = cursor;
    laneCursors.set(t, cursor + (c.sourceOutSec - c.sourceInSec) / ((c as { speed?: number }).speed ?? 1));
  }
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    durationSec: opts.durationSec,
    voice: VOICE,
    captions: { enabled: !!opts.captionsEnabled },
    foley: { enabled: true, volume: 1 },
    textOverlays: opts.textOverlays ?? [],
    sources: sources.map((s) => ({ id: s.id, filePath: s.filePath, displayName: "" })),
    video: videoClips,
    narration: (opts.narration ?? []).map((n) => ({
      id: n.id,
      startSec: n.startSec,
      narration: n.narration ?? "",
      pauseAfterSec: 0,
      estDurationSec: n.estDurationSec ?? 0,
      audio: n.audio
        ? { path: `audio/${n.id}.mp3`, durationSec: n.audio.dur }
        : null,
      ...(n.audioInSec != null ? { audioInSec: n.audioInSec } : {}),
      ...(n.audioOutSec != null ? { audioOutSec: n.audioOutSec } : {}),
      ...(n.track != null ? { track: n.track } : {}),
    })),
    ...(opts.audioLanes != null ? { audioLanes: opts.audioLanes } : {}),
  };
}

// ── planTimeline ─────────────────────────────────────────────────────────

test("video clips concat back-to-back; videoTotalSec is the sum", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      video: [{ in: 0, out: 10 }, { in: 20, out: 30 }],
    }),
    PROJ,
  );
  close(p.videoTotalSec, 20);
  close(p.finalDurationSec, 20);
  close(p.freezeExtendSec, 0);
  assert.equal(p.video.length, 2);
  // Source path resolved against project dir.
  assert.equal(p.video[0]!.sourcePath, path.resolve(PROJ, "input.mp4"));
});

test("clip speed re-scales played duration: 2× halves, 0.5× doubles the footprint", () => {
  const p = planTimeline(
    timeline({
      durationSec: 20,
      // 10s of source at 2× (plays in 5s) then 10s at 0.5× (plays in 20s).
      video: [{ in: 0, out: 10, speed: 2 }, { in: 0, out: 10, speed: 0.5 }],
    }),
    PROJ,
  );
  close(p.video[0]!.speed, 2);
  close(p.video[1]!.speed, 0.5);
  // videoTotalSec is in OUTPUT seconds: 10/2 + 10/0.5 = 5 + 20 = 25.
  close(p.videoTotalSec, 25);
  close(p.finalDurationSec, 25);
});

test("missing track defaults to lane 0; single-lane plan is unchanged", () => {
  const p = planTimeline(
    timeline({ durationSec: 20, video: [{ in: 0, out: 10 }, { in: 0, out: 10 }] }),
    PROJ,
  );
  close(p.videoTotalSec, 20); // back-to-back on the one lane
  assert.equal(p.video.length, 2);
});

test("multi-lane content is gated from export (preview-only)", () => {
  let code: string | undefined;
  try {
    planTimeline(
      timeline({
        durationSec: 10,
        // one clip on lane 0, one on lane 1 → overlap in time → can't export yet
        video: [{ in: 0, out: 10, track: 0 }, { in: 0, out: 5, track: 1 }],
      }),
      PROJ,
    );
  } catch (e) {
    code = (e as { code?: string }).code;
  }
  assert.equal(code, "multi-track-render-not-yet");
});

test("clips all on a single non-zero lane still export (no overlap)", () => {
  const p = planTimeline(
    timeline({ durationSec: 10, video: [{ in: 0, out: 6, track: 2 }, { in: 0, out: 4, track: 2 }] }),
    PROJ,
  );
  close(p.videoTotalSec, 10);
  assert.equal(p.video.length, 2);
});

test("missing speed defaults to 1× (legacy clips unchanged)", () => {
  const p = planTimeline(
    timeline({ durationSec: 10, video: [{ in: 0, out: 10 }] }),
    PROJ,
  );
  close(p.video[0]!.speed, 1);
  close(p.videoTotalSec, 10);
});

test("buildFilterGraph injects setpts speed only when ≠ 1×", () => {
  const sped = buildFilterGraph(
    planTimeline(timeline({ durationSec: 10, video: [{ in: 0, out: 10, speed: 2 }] }), PROJ),
  ).filter;
  // 2× = divide PTS by 2.
  assert.match(sped, /\[0:v\]trim=start=0:end=10,setpts=\(PTS-STARTPTS\)\/2/);

  const plain = buildFilterGraph(
    planTimeline(timeline({ durationSec: 10, video: [{ in: 0, out: 10 }] }), PROJ),
  ).filter;
  // 1× (absent) stays byte-identical to the legacy graph: no /speed divisor.
  assert.match(plain, /\[0:v\]trim=start=0:end=10,setpts=PTS-STARTPTS/);
  assert.doesNotMatch(plain, /setpts=\(PTS-STARTPTS\)\//);
});

test("no narration → silent track, no freeze-extend", () => {
  const p = planTimeline(timeline({ durationSec: 10 }), PROJ);
  assert.equal(p.audio.length, 0);
  close(p.freezeExtendSec, 0);
});

test("rendered narration becomes an audio placement at its startSec", () => {
  const p = planTimeline(
    timeline({
      durationSec: 20,
      narration: [
        { id: "nar-001", startSec: 2, audio: { dur: 4 } },
        { id: "nar-002", startSec: 10, audio: { dur: 3 } },
      ],
    }),
    PROJ,
  );
  assert.equal(p.audio.length, 2);
  close(p.audio[0]!.startSec, 2);
  close(p.audio[0]!.durationSec, 4);
  close(p.audio[1]!.startSec, 10);
});

test("audio overrun freeze-extends the video, finalDur honours both", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      narration: [{ id: "nar-001", startSec: 8, audio: { dur: 6 } }],
    }),
    PROJ,
  );
  close(p.videoTotalSec, 10);
  close(p.finalDurationSec, 14); // last audio end = 14
  close(p.freezeExtendSec, 4);
});

test("unrendered narration (audio=null) is ignored by the planner", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      narration: [{ id: "nar-001", startSec: 0 }], // no audio
    }),
    PROJ,
  );
  assert.equal(p.audio.length, 0);
});

test("trimmed narration: placement carries in/out and played duration = slice", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [{ id: "nar-001", startSec: 5, audio: { dur: 8 }, audioInSec: 2, audioOutSec: 5 }],
    }),
    PROJ,
  );
  assert.equal(p.audio.length, 1);
  const a = p.audio[0]!;
  close(a.sourceInSec, 2);
  close(a.sourceOutSec, 5);
  close(a.durationSec, 3); // played slice = out - in, NOT the 8s file
  close(a.audioFileDurationSec, 8);
  close(a.startSec, 5);
});

test("trimmed narration emits a source atrim; untrimmed does not", () => {
  const trimmed = planTimeline(
    timeline({ durationSec: 30, narration: [{ id: "nar-001", startSec: 0, audio: { dur: 8 }, audioInSec: 2, audioOutSec: 5 }] }),
    PROJ,
  );
  const full = planTimeline(
    timeline({ durationSec: 30, narration: [{ id: "nar-001", startSec: 0, audio: { dur: 8 } }] }),
    PROJ,
  );
  const trimmedFilter = buildFilterGraph(trimmed).filter;
  const fullFilter = buildFilterGraph(full).filter;
  assert.match(trimmedFilter, /atrim=start=2:end=5/);
  assert.doesNotMatch(fullFilter, /atrim=start=/); // untrimmed stays byte-identical
});

test("audio placements are sorted by startSec regardless of insertion order", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "nar-002", startSec: 20, audio: { dur: 1 } },
        { id: "nar-001", startSec: 5,  audio: { dur: 1 } },
        { id: "nar-003", startSec: 12, audio: { dur: 1 } },
      ],
    }),
    PROJ,
  );
  assert.deepEqual(p.audio.map((a) => a.id), ["nar-001", "nar-003", "nar-002"]);
});

test("overlapping audio is permitted (amix sums them; operator chose to overlap)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "nar-001", startSec: 0, audio: { dur: 10 } },
        { id: "nar-002", startSec: 5, audio: { dur: 10 } },
      ],
    }),
    PROJ,
  );
  assert.equal(p.audio.length, 2);
});

test("voiceover lane with no mix settings — export is byte-identical regardless of lane", () => {
  // Absent per-lane mix settings (audioLanes), the planner mixes every lane
  // equally into the same amix bus at unity gain. So moving a clip to another
  // lane must NOT change the audio plan (placements, startSec, durations,
  // order, gain). Per-lane volume/mute is opt-in via audioLanes (tested below).
  const base = {
    durationSec: 30,
    narration: [
      { id: "nar-001", startSec: 0, audio: { dur: 10 } },
      { id: "nar-002", startSec: 5, audio: { dur: 10 } },
    ],
  };
  const flat = planTimeline(timeline(base), PROJ);
  const laned = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "nar-001", startSec: 0, audio: { dur: 10 }, track: 0 },
        { id: "nar-002", startSec: 5, audio: { dur: 10 }, track: 2 },
      ],
    }),
    PROJ,
  );
  assert.deepEqual(laned.audio, flat.audio);
  close(laned.finalDurationSec, flat.finalDurationSec);
  // No mix settings ⇒ every placement rides at unity gain.
  for (const a of laned.audio) close(a.gain, 1);
});

// ── per-lane volume / mute (audioLanes) ───────────────────────────────────

test("voiceover lane volume sets the placement gain; other lanes stay at unity", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "vo-001", startSec: 0, audio: { dur: 10 }, track: 0 },
        { id: "bed-001", startSec: 0, audio: { dur: 10 }, track: 1 },
      ],
      // Lane 1 (music bed) at 30%; lane 0 left default.
      audioLanes: [{ volume: 1, muted: false }, { volume: 0.3, muted: false }],
    }),
    PROJ,
  );
  const byId = new Map(p.audio.map((a) => [a.id, a]));
  close(byId.get("vo-001")!.gain, 1);
  close(byId.get("bed-001")!.gain, 0.3);
});

test("muted voiceover lane drops its placements from the plan entirely", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "vo-001", startSec: 0, audio: { dur: 10 }, track: 0 },
        { id: "bed-001", startSec: 0, audio: { dur: 10 }, track: 1 },
      ],
      audioLanes: [{ volume: 1, muted: false }, { volume: 1, muted: true }],
    }),
    PROJ,
  );
  assert.equal(p.audio.length, 1);
  assert.equal(p.audio[0]!.id, "vo-001");
});

test("a muted trailing lane does not extend the timeline audio tail", () => {
  // Lane-1 clip runs to 40s but is muted; final duration should follow the
  // unmuted lane-0 clip (to 10s), not the dropped muted one.
  const p = planTimeline(
    timeline({
      durationSec: 40,
      video: [{ in: 0, out: 8 }],
      narration: [
        { id: "vo-001", startSec: 0, audio: { dur: 10 }, track: 0 },
        { id: "bed-001", startSec: 30, audio: { dur: 10 }, track: 1 },
      ],
      audioLanes: [{ volume: 1, muted: false }, { volume: 1, muted: true }],
    }),
    PROJ,
  );
  close(p.finalDurationSec, 10);
});

test("a muted lane drops its captions too (consistent with dropping its audio)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      captionsEnabled: true,
      narration: [
        { id: "vo-001", startSec: 0, audio: { dur: 5 }, narration: "heard line", track: 0 },
        { id: "bed-001", startSec: 0, audio: { dur: 5 }, narration: "muted line", track: 1 },
      ],
      audioLanes: [{ volume: 1, muted: false }, { volume: 1, muted: true }],
    }),
    PROJ,
  );
  assert.deepEqual(p.captions.map((c) => c.id), ["vo-001"]);
});

test("buildFilterGraph emits volume= only for a lane gain ≠ 1", () => {
  const unity = buildFilterGraph(
    planTimeline(timeline({ durationSec: 30, narration: [{ id: "a", startSec: 0, audio: { dur: 5 } }] }), PROJ),
  ).filter;
  assert.ok(!unity.includes("volume="), `unity gain should not emit volume=: ${unity}`);

  const boosted = buildFilterGraph(
    planTimeline(
      timeline({
        durationSec: 30,
        narration: [
          { id: "a", startSec: 0, audio: { dur: 5 }, track: 0 },
          { id: "b", startSec: 0, audio: { dur: 5 }, track: 1 },
        ],
        audioLanes: [{ volume: 1, muted: false }, { volume: 0.5, muted: false }],
      }),
      PROJ,
    ),
  ).filter;
  assert.ok(boosted.includes("volume=0.5"), `lane gain should emit volume=0.5: ${boosted}`);
});

test("video clip with non-positive duration throws", () => {
  assert.throws(
    () => planTimeline(timeline({ durationSec: 5, video: [{ in: 5, out: 5 }] }), PROJ),
    /non-positive duration/,
  );
});

test("unknown source id throws", () => {
  const t = timeline({ durationSec: 10 });
  t.video[0]!.sourceId = "src-missing";
  assert.throws(() => planTimeline(t, PROJ), /unknown source/);
});

test("video clips not back-to-back throws (Phase 1.2 invariant)", () => {
  const t = timeline({
    durationSec: 30,
    video: [{ in: 0, out: 10 }, { in: 0, out: 10 }],
  });
  // Hand-corrupt the second clip's timelineStartSec to break back-to-back.
  t.video[1]!.timelineStartSec = 15;
  assert.throws(() => planTimeline(t, PROJ), /back-to-back/);
});

// ── buildFilterGraph ─────────────────────────────────────────────────────

test("single-clip + zero audio → trim,setpts → concat → null vout + anullsrc aout", () => {
  const p = planTimeline(timeline({ durationSec: 10 }), PROJ);
  const { inputs, filter } = buildFilterGraph(p);
  assert.deepEqual(inputs, [path.resolve(PROJ, "input.mp4")]);
  assert.match(filter, /\[0:v\]trim=start=0:end=10/);
  assert.match(filter, /concat=n=1:v=1:a=0\[vcat\]/);
  assert.match(filter, /\[vcat\]null\[vout\]/);
  assert.match(filter, /anullsrc.*\[aout\]/);
});

test("audio overrun → tpad freeze in the graph", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      narration: [{ id: "nar-001", startSec: 5, audio: { dur: 10 } }],
    }),
    PROJ,
  );
  const { filter } = buildFilterGraph(p);
  // freezeExtendSec = (5+10) - 10 = 5
  assert.match(filter, /\[vcat\]tpad=stop_mode=clone:stop_duration=5\[vout\]/);
});

test("multiple audio placements → adelay per clip then amix", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      narration: [
        { id: "nar-001", startSec: 0,  audio: { dur: 3 } },
        { id: "nar-002", startSec: 10, audio: { dur: 3 } },
      ],
    }),
    PROJ,
  );
  const { inputs, filter } = buildFilterGraph(p);
  // 1 video source + 2 audio inputs
  assert.equal(inputs.length, 3);
  // first audio at startSec=0 ⇒ no adelay
  assert.doesNotMatch(filter, /\[1:a\][^;]*adelay/);
  // second audio at startSec=10 ⇒ adelay=10000ms
  assert.match(filter, /\[2:a\][^;]*adelay=delays=10000:all=1/);
  assert.match(filter, /\[a0\]\[a1\]amix=inputs=2:normalize=0\[aout\]/);
});

test("single audio placement → anull alias not amix (n=1 wasteful)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      narration: [{ id: "nar-001", startSec: 2, audio: { dur: 3 } }],
    }),
    PROJ,
  );
  const { filter } = buildFilterGraph(p);
  assert.match(filter, /\[a0\]anull\[aout\]/);
  assert.doesNotMatch(filter, /amix/);
});

// ── captions (Slice 1) ───────────────────────────────────────────────────

test("captions disabled → no drawtext in filter, plan.captions empty", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      captionsEnabled: false,
      narration: [{ id: "nar-001", startSec: 0, narration: "Hello world", audio: { dur: 3 } }],
    }),
    PROJ,
  );
  assert.equal(p.captions.length, 0);
  const { filter } = buildFilterGraph(p);
  assert.doesNotMatch(filter, /drawtext/);
});

test("captions enabled but narration empty → still no captions (text required)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      captionsEnabled: true,
      // empty narration text — nothing to caption
      narration: [{ id: "nar-001", startSec: 0, audio: { dur: 3 } }],
    }),
    PROJ,
  );
  assert.equal(p.captions.length, 0);
});

test("captions enabled with rendered narration → drawtext timed to audio window", () => {
  const p = planTimeline(
    timeline({
      durationSec: 20,
      captionsEnabled: true,
      narration: [
        { id: "nar-001", startSec: 2, narration: "First line", audio: { dur: 4 } },
        { id: "nar-002", startSec: 10, narration: "Second line", audio: { dur: 3 } },
      ],
    }),
    PROJ,
  );
  assert.equal(p.captions.length, 2);
  assert.equal(p.captions[0]!.text, "First line");
  assert.equal(p.captions[0]!.startSec, 2);
  assert.equal(p.captions[0]!.durationSec, 4);

  const files = new Map<string, string>([
    ["nar-001", "/tmp/captions/nar-001.txt"],
    ["nar-002", "/tmp/captions/nar-002.txt"],
  ]);
  const { filter } = buildFilterGraph(p, { captionTextFiles: files });
  // chained drawtext on [vfin] → [vout]
  assert.match(filter, /\[vfin\]drawtext=.*drawtext=.*\[vout\]/);
  // Each drawtext gates by between(t,start,end) with escaped commas.
  assert.match(filter, /between\(t\\,2\\,6\)/);
  assert.match(filter, /between\(t\\,10\\,13\)/);
  // textfile paths escaped (colons in /tmp/… are fine; no colons in path).
  assert.match(filter, /textfile=\/tmp\/captions\/nar-001\.txt/);
});

test("captions enabled with unrendered narration → falls back to estDurationSec", () => {
  const p = planTimeline(
    timeline({
      durationSec: 20,
      captionsEnabled: true,
      narration: [
        { id: "nar-001", startSec: 0, narration: "Draft caption", estDurationSec: 2.5 },
      ],
    }),
    PROJ,
  );
  assert.equal(p.captions.length, 1);
  assert.equal(p.captions[0]!.durationSec, 2.5);
});

test("captions use [vfin] intermediate after tpad when audio overruns", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      captionsEnabled: true,
      narration: [
        { id: "nar-001", startSec: 8, narration: "Over the edge", audio: { dur: 6 } },
      ],
    }),
    PROJ,
  );
  const files = new Map<string, string>([["nar-001", "/tmp/c.txt"]]);
  const { filter } = buildFilterGraph(p, { captionTextFiles: files });
  // tpad still drops onto the intermediate label so captions can chain after it.
  assert.match(filter, /\[vcat\]tpad=stop_mode=clone:stop_duration=4\[vfin\]/);
  assert.match(filter, /\[vfin\]drawtext=.*\[vout\]/);
});

test("buildFilterGraph throws when caption has no textfile (caller bug)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      captionsEnabled: true,
      narration: [{ id: "nar-001", startSec: 0, narration: "Hello", audio: { dur: 2 } }],
    }),
    PROJ,
  );
  assert.throws(() => buildFilterGraph(p, {}), /no textfile for caption/);
});

// ── text overlays (Slice 2) ──────────────────────────────────────────────

test("no text overlays → graph unchanged from baseline", () => {
  const p = planTimeline(timeline({ durationSec: 10 }), PROJ);
  assert.equal(p.textOverlays.length, 0);
  const { filter } = buildFilterGraph(p);
  assert.doesNotMatch(filter, /drawtext/);
});

test("text overlay → drawtext with operator-chosen position + style", () => {
  const p = planTimeline(
    timeline({
      durationSec: 30,
      textOverlays: [{
        id: "ov-001",
        startSec: 5,
        durationSec: 4,
        text: "Welcome",
        position: { vertical: "top", horizontal: "left" },
        style: { fontSize: 48, color: "yellow", boxColor: "rgba(255,0,0,0.7)" },
      }],
    }),
    PROJ,
  );
  assert.equal(p.textOverlays.length, 1);
  const files = new Map<string, string>([["ov-001", "/tmp/overlays/ov-001.txt"]]);
  const { filter } = buildFilterGraph(p, { overlayTextFiles: files });
  // Position: top-left → x=48, y=48
  assert.match(filter, /x=48:y=48/);
  // Style passed through verbatim
  assert.match(filter, /fontsize=48/);
  assert.match(filter, /fontcolor=yellow/);
  // boxcolor=rgba(255,0,0,0.7) gets normalised to 0xff0000@0.7 by
  // ffmpegColor() — commas would break the filter-param parser.
  assert.match(filter, /boxcolor=0xff0000@0\.7/);
  // Timing
  assert.match(filter, /between\(t\\,5\\,9\)/);
});

test("text overlay with empty boxColor → no box param emitted", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      textOverlays: [{
        id: "ov-001",
        startSec: 0,
        durationSec: 3,
        text: "no box",
        position: { vertical: "bottom", horizontal: "center" },
        style: { fontSize: 24, color: "white", boxColor: "" },
      }],
    }),
    PROJ,
  );
  const files = new Map<string, string>([["ov-001", "/tmp/o.txt"]]);
  const { filter } = buildFilterGraph(p, { overlayTextFiles: files });
  assert.doesNotMatch(filter, /box=1/);
  assert.doesNotMatch(filter, /boxcolor=/);
});

test("captions + overlays coexist in one drawtext chain", () => {
  const p = planTimeline(
    timeline({
      durationSec: 20,
      captionsEnabled: true,
      narration: [{ id: "nar-001", startSec: 0, narration: "hello", audio: { dur: 2 } }],
      textOverlays: [{
        id: "ov-001",
        startSec: 5,
        durationSec: 3,
        text: "title",
        position: { vertical: "top", horizontal: "center" },
        style: { fontSize: 36, color: "white", boxColor: "rgba(0,0,0,0.55)" },
      }],
    }),
    PROJ,
  );
  const cFiles = new Map<string, string>([["nar-001", "/tmp/c.txt"]]);
  const oFiles = new Map<string, string>([["ov-001", "/tmp/o.txt"]]);
  const { filter } = buildFilterGraph(p, { captionTextFiles: cFiles, overlayTextFiles: oFiles });
  // Single chain on [vfin]: caption drawtext THEN overlay drawtext.
  assert.match(filter, /\[vfin\]drawtext=.*\/tmp\/c\.txt.*,drawtext=.*\/tmp\/o\.txt.*\[vout\]/);
});

test("empty text on an overlay drops it from the plan", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      textOverlays: [
        { id: "ov-001", startSec: 0, durationSec: 2, text: "   ", position: { vertical: "bottom", horizontal: "center" }, style: { fontSize: 24, color: "white", boxColor: "" } },
        { id: "ov-002", startSec: 3, durationSec: 2, text: "real", position: { vertical: "bottom", horizontal: "center" }, style: { fontSize: 24, color: "white", boxColor: "" } },
      ],
    }),
    PROJ,
  );
  assert.equal(p.textOverlays.length, 1);
  assert.equal(p.textOverlays[0]!.id, "ov-002");
});

test("buildFilterGraph throws when overlay textfile missing (caller bug)", () => {
  const p = planTimeline(
    timeline({
      durationSec: 10,
      textOverlays: [{ id: "ov-001", startSec: 0, durationSec: 2, text: "x", position: { vertical: "bottom", horizontal: "center" }, style: { fontSize: 24, color: "white", boxColor: "" } }],
    }),
    PROJ,
  );
  assert.throws(() => buildFilterGraph(p, {}), /no textfile for overlay/);
});

// ── Phase 2.1: multi-source video ────────────────────────────────────────
// The Phase 1.1 schema already accepts multiple sources + multiple
// clips, and the stitch graph already iterates them (each clip gets
// its own trim+setpts, all concat together). Phase 2 unlocks this in
// the UI; these tests pin the back-end so a future UI regression has
// a hard wall to hit.

test("two distinct sources → two -i inputs, per-clip trims, concat in order", () => {
  const t = timeline({
    durationSec: 0, // overwritten below
    sources: [
      { id: "src-a", filePath: "first.mp4" },
      { id: "src-b", filePath: "second.mp4" },
    ],
    video: [
      { in: 0, out: 5, sourceId: "src-a" },
      { in: 10, out: 18, sourceId: "src-b" },
    ],
  });
  t.durationSec = 13; // 5 + 8
  const p = planTimeline(t, PROJ);
  close(p.videoTotalSec, 13);
  assert.equal(p.video.length, 2);
  assert.equal(p.video[0]!.sourcePath, path.resolve(PROJ, "first.mp4"));
  assert.equal(p.video[1]!.sourcePath, path.resolve(PROJ, "second.mp4"));
  const { inputs, filter } = buildFilterGraph(p);
  // One -i per unique source file.
  assert.deepEqual(inputs, [path.resolve(PROJ, "first.mp4"), path.resolve(PROJ, "second.mp4")]);
  // Per-clip trims reference the right input pad.
  assert.match(filter, /\[0:v\]trim=start=0:end=5/);
  assert.match(filter, /\[1:v\]trim=start=10:end=18/);
  // Concat over both clips.
  assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vcat\]/);
});

test("normalizeTo scales+pads every clip so concat gets a uniform frame size", () => {
  const t = timeline({
    durationSec: 13,
    sources: [{ id: "src-a", filePath: "first.mp4" }, { id: "src-b", filePath: "second.mp4" }],
    video: [{ in: 0, out: 5, sourceId: "src-a" }, { in: 10, out: 18, sourceId: "src-b" }],
  });
  const p = planTimeline(t, PROJ);
  const f = buildFilterGraph(p, { normalizeTo: { width: 1920, height: 1080 } }).filter;
  const norm = f.match(/scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black,setsar=1/g) || [];
  assert.equal(norm.length, 2); // both clips normalized
  // Absent normalizeTo ⇒ no scale/pad (single-resolution projects untouched).
  assert.doesNotMatch(buildFilterGraph(p).filter, /force_original_aspect_ratio/);
});

test("videoHeight scales caption fontsize; default stays 28", () => {
  const p = planTimeline(
    timeline({ durationSec: 10, captionsEnabled: true, narration: [{ id: "nar-001", startSec: 0, narration: "hi", audio: { dur: 4 } }] }),
    PROJ,
  );
  const files = new Map([["nar-001", "/tmp/c/nar-001.txt"]]);
  assert.match(buildFilterGraph(p, { captionTextFiles: files, videoHeight: 1080 }).filter, /fontsize=42/); // round(1080/26)
  assert.match(buildFilterGraph(p, { captionTextFiles: files }).filter, /fontsize=28/);
});

test("same source referenced by two clips → single -i, two trim chains", () => {
  const t = timeline({
    durationSec: 0,
    sources: [{ id: "src-only", filePath: "only.mp4" }],
    video: [
      // E.g. operator trimmed out the boring middle of one source video.
      { in: 0, out: 4, sourceId: "src-only" },
      { in: 30, out: 38, sourceId: "src-only" },
    ],
  });
  t.durationSec = 12;
  const p = planTimeline(t, PROJ);
  const { inputs, filter } = buildFilterGraph(p);
  // Only ONE input — the second clip reuses [0:v].
  assert.equal(inputs.length, 1);
  // Two distinct trim chains, both off [0:v].
  assert.match(filter, /\[0:v\]trim=start=0:end=4,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(filter, /\[0:v\]trim=start=30:end=38,setpts=PTS-STARTPTS\[v1\]/);
});

test("source audio is dropped: stitch only outputs narration audio (or silence)", () => {
  // Regression for the "what about the source's original audio?" question.
  // The current model is: source video audio is NEVER included in the
  // final output — the narration bus is the only audio source. This
  // matches the operator's mental model ("voiceover replaces the original
  // sound") and is what scoring + previous behavior assumed.
  const p = planTimeline(
    timeline({
      durationSec: 10,
      video: [{ in: 0, out: 10 }],
    }),
    PROJ,
  );
  const { filter } = buildFilterGraph(p);
  // Video stream: explicit concat with a=0 (no source audio carried).
  assert.match(filter, /concat=n=1:v=1:a=0/);
  // Audio stream: anullsrc (silence) since no narration is on the timeline.
  assert.match(filter, /anullsrc.*\[aout\]/);
  // Critically: no `:a=1` and no `[0:a]` reference anywhere — confirming
  // we don't accidentally start mixing in the source's audio track.
  assert.doesNotMatch(filter, /:a=1/);
  assert.doesNotMatch(filter, /\[0:a\]/);
});

test("multi-source with narration: audio bus stays narration-only", () => {
  const t = timeline({
    durationSec: 0,
    sources: [
      { id: "src-a", filePath: "a.mp4" },
      { id: "src-b", filePath: "b.mp4" },
    ],
    video: [
      { in: 0, out: 6, sourceId: "src-a" },
      { in: 0, out: 4, sourceId: "src-b" },
    ],
    narration: [
      { id: "nar-001", startSec: 1, narration: "hi", audio: { dur: 2 } },
    ],
  });
  t.durationSec = 10;
  const p = planTimeline(t, PROJ);
  assert.equal(p.audio.length, 1);
  const { filter } = buildFilterGraph(p);
  // The narration audio file is input #2 (after the two video sources).
  assert.match(filter, /\[2:a\].*adelay=delays=1000:all=1/);
  // No source-audio refs.
  assert.doesNotMatch(filter, /\[0:a\]/);
  assert.doesNotMatch(filter, /\[1:a\]/);
});

test("timelineStartSec mismatch → diagnostic error names the clip and expected value", () => {
  // The planner's back-to-back invariant is the load-bearing constraint
  // that lets multi-clip stitch work without gaps. The error message
  // has to name BOTH the offender and what the planner expected, so the
  // UI (and future operators editing JSON by hand) can fix it.
  const t = timeline({
    durationSec: 20,
    video: [{ in: 0, out: 5 }, { in: 0, out: 8 }],
  });
  // Hand-corrupt clip 2's timelineStartSec to a value that doesn't match
  // the cumulative back-to-back layout.
  t.video[1]!.timelineStartSec = 12;
  assert.throws(
    () => planTimeline(t, PROJ),
    /vid-002 expects timelineStartSec 5.*back-to-back.*got 12/,
  );
});

// ── ffmpegColor (filter-param escape) ────────────────────────────────────

test("ffmpegColor passes named + native syntax through unchanged", () => {
  assert.equal(ffmpegColor("white"), "white");
  assert.equal(ffmpegColor("black@0.55"), "black@0.55");
  assert.equal(ffmpegColor("0xff0000"), "0xff0000");
  assert.equal(ffmpegColor("0xff0000@0.5"), "0xff0000@0.5");
});

test("ffmpegColor converts rgba(R,G,B,A) → 0xRRGGBB@A (kills the comma trap)", () => {
  // The commas in rgba() were the bug — ffmpeg's filter-param parser
  // treats them as filter-chain separators and the whole graph blows up
  // with "No option name near '10:x=(w-text_w)/2'". The conversion has
  // to produce a comma-free string.
  assert.equal(ffmpegColor("rgba(0,0,0,0.55)"), "0x000000@0.55");
  assert.equal(ffmpegColor("rgba(255, 0, 0, 0.7)"), "0xff0000@0.7");
  // Fully-opaque rgba() drops the alpha suffix.
  assert.equal(ffmpegColor("rgba(255,255,255,1)"), "0xffffff");
  assert.doesNotMatch(ffmpegColor("rgba(0,0,0,0.55)"), /,/);
});

test("ffmpegColor converts rgb(R,G,B) → 0xRRGGBB", () => {
  assert.equal(ffmpegColor("rgb(0,128,255)"), "0x0080ff");
});

test("ffmpegColor expands #rgb shorthand to 0xrrggbb", () => {
  assert.equal(ffmpegColor("#f0f"), "0xff00ff");
  assert.equal(ffmpegColor("#abc"), "0xaabbcc");
});

test("text overlay with rgba() boxColor produces a comma-free drawtext arg", () => {
  // End-to-end pinning of the actual bug.
  const p = planTimeline(
    timeline({
      durationSec: 10,
      textOverlays: [{
        id: "ov-001",
        startSec: 0,
        durationSec: 3,
        text: "hi",
        position: { vertical: "bottom", horizontal: "center" },
        style: { fontSize: 36, color: "white", boxColor: "rgba(0,0,0,0.55)" },
      }],
    }),
    PROJ,
  );
  const files = new Map<string, string>([["ov-001", "/tmp/o.txt"]]);
  const { filter } = buildFilterGraph(p, { overlayTextFiles: files });
  // The drawtext slice for this overlay must NOT contain rgba(0 or similar.
  const overlayChunk = filter.match(/drawtext=textfile=\/tmp\/o\.txt[^,]*(?:,(?!drawtext)[^,]*)*/)![0];
  assert.match(overlayChunk, /boxcolor=0x000000@0\.55/);
  assert.doesNotMatch(overlayChunk, /rgba\(/);
});

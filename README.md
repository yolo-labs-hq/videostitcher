# videostitcher

Automated screencast voiceover pipeline. Submit a screen recording plus a short
brief; the tool analyzes the video, drafts a narration script for you to review,
generates a voiceover, and stitches it back over the footage.

The pipeline is a chain of **idempotent stages**, each reading the previous
stage's artifact from a per-video **project directory** and writing its own:

```
project.json   init        scaffold the project
analysis.json  analyze     Gemini video analysis              [Phase 3 — shipped]
script.json    script      Claude narration script            [Phase 4 — shipped]  ← review/edit here
voice.json     voice       ElevenLabs voiceover               [Phase 2 — shipped]
out/final.mp4  stitch      ffmpeg assembly                    [Phase 1 — shipped]
```

Because each stage persists its artifact, you can re-run any stage without
repeating (or re-paying for) the ones before it — and the `script.json` is a
plain, hand-editable file, so you review the narration before any paid voiceover
call.

## Status — Phases 1–4 (the full pipeline)

Shipped and verified end-to-end:

- `run` — drive the whole pipeline in one command:
  `init → analyze → script → (review) → voice → stitch`. **Resumable** — skips
  `analyze`/`script` when their artifacts already exist (so hand-edits to
  `script.json` survive a re-run; `--force` redoes them) and reuses voice clips
  on disk (`--revoice` re-bills). **Pauses for narration review** before the
  paid voice stage whenever the script was (re)generated this run; `-y/--yes`
  runs fully non-interactive.
- `init` — create a project directory for a source video.
- `analyze` — upload the video to Gemini, wait for processing, and produce
  `analysis.json`: a timestamped, normalized segment timeline (sorted, overlaps
  repaired, clamped to the real duration). `--fps` raises the sampling rate to
  catch fast UI changes; `--draft-script` also emits a placeholder `script.json`.
- `script` — turn `analysis.json` into polished, timing-aware narration with
  Claude (`claude-opus-4-7`, adaptive thinking, Zod-validated structured output,
  prompt caching). The analysis stays authoritative for timing; Claude only
  writes prose, matched back by segment id. Refuses to overwrite an existing
  `script.json` without `--force` (it's the human-edited handoff). `--effort`
  tunes thinking depth. `--dry-run` calls `/count_tokens` (free) to print an
  exact input-token count plus a projected output range and cost band — no
  script written.
- `voices` — list the ElevenLabs voices on your account (set one as
  `voice.voiceId` in `script.json`, or pass `--voice <id>`).
- `voice` — generate the **real** ElevenLabs voiceover for each narrated
  segment. Bills per character, so it: shows a cost estimate and **prompts
  before any API call** (`--dry-run` to estimate only, `-y` to skip the
  prompt); passes adjacent-segment text for cross-cut prosody continuity; and
  **reuses clips already on disk** so a re-run (or a failed run) never
  re-bills (`--force` to regenerate).
- `mock-voice` — render **silent** placeholder narration sized by word count,
  so the stitch can be exercised offline with no API budget.
- `stitch` — assemble the final video, **replacing the original audio entirely**
  with the timed narration track.
- `doctor` — confirm the bundled ffmpeg/ffprobe are runnable.

All four stages are implemented; the pipeline runs end to end.

Auth: set `VIDEOSTITCHER_GEMINI_API_KEY` for `analyze`, `VIDEOSTITCHER_ANTHROPIC_API_KEY`
for `script`, and `VIDEOSTITCHER_ELEVENLABS_API_KEY` for `voice` — or pass
`--api-key` to each. `GEMINI_BASE_URL` / `ANTHROPIC_BASE_URL` /
`ELEVENLABS_BASE_URL` override the API hosts (used for local testing).

## Install / build

Not published to npm; run it from source:

```bash
npm install
npm run build      # → dist/
npm test           # timing-engine unit tests
```

ffmpeg/ffprobe are bundled via `ffmpeg-static` / `ffprobe-static` — no system
install needed. Override with `FFMPEG_PATH` / `FFPROBE_PATH` to use a host build.

## Usage

One command for the whole pipeline (pauses for you to review the script before voicing):

```bash
export VIDEOSTITCHER_GEMINI_API_KEY=...  VIDEOSTITCHER_ANTHROPIC_API_KEY=...  VIDEOSTITCHER_ELEVENLABS_API_KEY=...
node dist/cli.js run ./demo.mp4 --brief brief.txt --voice <voiceId> --dir ./projects/demo
#   → pauses after the script; edit ./projects/demo/script.json, confirm, and it finishes
#   add -y to run non-interactive; re-run to resume (finished stages are skipped)
```

…or drive the stages individually:

```bash
# 1. scaffold a project
node dist/cli.js init ./demo.mp4 --brief brief.txt --dir ./projects/demo

# 2. analyze the video (Gemini) → analysis.json
export VIDEOSTITCHER_GEMINI_API_KEY=...
node dist/cli.js analyze ./projects/demo --fps 2

# 2b. write narration from the analysis (Claude) → script.json
export VIDEOSTITCHER_ANTHROPIC_API_KEY=...
node dist/cli.js script ./projects/demo

#    then edit ./projects/demo/script.json — refine narration before voicing
#    (--force regenerates; or hand-author script.json directly and skip steps 2/2b)

# 3a. real voiceover (ElevenLabs)
export VIDEOSTITCHER_ELEVENLABS_API_KEY=...
node dist/cli.js voices                       # pick a voice id
node dist/cli.js voice ./projects/demo --voice <id> --dry-run   # estimate cost
node dist/cli.js voice ./projects/demo --voice <id>             # generate (prompts to confirm)

# 3b. …or mock the voiceover to test timing offline (no API budget)
node dist/cli.js mock-voice ./projects/demo

# 4. stitch
node dist/cli.js stitch ./projects/demo
#    → ./projects/demo/out/final.mp4
```

## Auto-foley (click / keypress sounds)

Screencast takes recorded by the platform's rig carry an `inputs.json`
sidecar — the timestamp of every click and keystroke the take performed
(timing only, never typed content). When a timeline source has one
(`<video minus ext>.inputs.json` next to the source file; the tile app's
workspace import copies it automatically), `stitch` mixes a foley track
into the output: click and key sounds at the moments the viewer SEES the
interaction, remapped through every cut, trim, and per-clip speed change.

No sound assets are needed — clicks and key ticks are synthesized in-process
(enveloped sine+noise transients with deterministic per-key variation, so
typing doesn't sound mechanical and re-renders are byte-identical). To use
real recordings instead, drop any of `click.wav` / `key.wav` / `space.wav` /
`enter.wav` into `<projectDir>/foley-samples/` — each kind falls back to
synthesis when its file is absent.

Control via `timeline.json`: `"foley": { "enabled": false }` turns it off;
`"volume"` (0–2, default 1) scales the track. Foley is best-effort by
contract — a malformed sidecar or failed render never fails the stitch.
The remap math lives in `src/foley.ts` (`remapFoleyEvents`, pure) with
tests in `src/foley.test.ts`.

## The timing engine

Narration almost never matches the on-screen segment length. The strategy is
**hybrid with a ±15% tolerance** (`--tolerance` to change). Per segment, with
`videoDur` = source span and `audioDur` = narration length:

| Condition | Behavior |
|---|---|
| `audioDur ≤ videoDur` | keep video timing, pad narration with trailing silence |
| `videoDur < audioDur ≤ videoDur × 1.15` | speed narration up (≤1.15×) to fit; video unchanged |
| `audioDur > videoDur × 1.15` | cap narration at 1.15×, then freeze-extend the last video frame to wait for it |

`pauseAfterSec` adds a deliberate gap, absorbed by both the trailing silence and
the freeze-extend. Gaps between segments — and any head/tail of uncovered
footage — become silent **filler** segments, so the whole source video survives
into the output. Every segment's audio and video lengths are made equal, which
keeps the two concat streams from drifting.

The math lives in `src/timing.ts` as a pure function (`planTimeline`) with unit
tests in `src/timing.test.ts`; `src/stitch.ts` only translates the resulting
plan into an ffmpeg `filter_complex` graph.

## Artifacts

All schemas are zod-validated in `src/types.ts`. Key files in a project dir:

- `project.json` — source video path, brief, name.
- `script.json` — `{ durationSec, voice, segments: [{ id, startSec, endSec, narration, pauseAfterSec }] }`. **The review handoff.**
- `voice.json` — `{ segments: [{ id, audioPath, durationSec }] }`. Written by `mock-voice` (and, later, the real `voice` stage).
- `audio/` — rendered narration clips. `out/final.mp4` — the result.

## Web editor (YOLO Studio tile-app)

`server/server.mjs` is a small, dependency-free Node server that drives the same
pipeline through the library build (`dist/index.js`) and serves a single-page
timeline editor from `public/`. In [YOLO Studio](https://yolo.studio) it runs as
a tile-app and talks to the host through
[`@yolo-labs/app-sdk`](https://github.com/yolo-labs-hq/app-sdk). You can also run
it locally:

```bash
npm run build
HOST=127.0.0.1 node server/server.mjs   # http://127.0.0.1:7891 (PORT to change)
```

Keys are bring-your-own: the page keeps your Gemini, Claude and ElevenLabs keys
in memory and sends them with each request; the server never stores them. With
no keys and the mock voice, the whole pipeline runs offline. Projects and
uploads live under `TILEAPP_DATA_DIR` (default: `$HOME`).

## Source & contributing

[github.com/yolo-labs-hq/videostitcher](https://github.com/yolo-labs-hq/videostitcher) is a public mirror of `packages/videostitcher` in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](./LICENSE).

# Unified Timeline Redesign

Status: draft 2026-05-27.

## Why

The current videostitcher UI surfaces three tracks (purple "script segment",
green "voice clip", red "voice clip overflow") which directly mirror the
pipeline stages (analyze → script → voice). That coupling leaks into the
editing surface and confuses operators: a script segment is "text + timing
window", a voice clip is "rendered audio that must live inside that
window", and overflow-red flags the case where the audio doesn't fit. None
of those distinctions matter to someone editing a video.

This plan replaces the three-track view with two: one **audio** track
(red = unrendered narration, green = rendered) and one **video** track
(supporting multiple source clips with trim + drag). Audio and video are
fully independent — audio lives at its own `startSec`, video plays
underneath at its own coords. The "audio must stay inside its script
segment" constraint and the overflow-red warning both disappear.

## Goals

- Single audio track with **red → green** lifecycle: narration is
  composed/dragged/sized at zero cost while red, then rendered to audio
  on demand (per-clip or batch) which turns it green.
- Editing narration text on a green clip invalidates the audio and
  returns it to red — the audio no longer matches the script.
- Video track supports **multiple source clips**, each with independent
  trim (source in/out) and timeline position. Drop a video file onto
  the track to add a new source.
- Existing projects auto-migrate. Old `script.json` / `voice.json` are
  kept as `.bak` for one release for forensic recovery.

## Non-goals (this iteration)

- Transitions between video clips (cut-only).
- Per-clip audio fade / gain controls beyond what exists today.
- Multiple audio tracks (music bed + narration).
- Text overlays / titles.
- Effects, filters, color correction.

## Data model

A single `timeline.json` replaces `script.json` + `voice.json`:

```json
{
  "schemaVersion": 2,
  "durationSec": 120,
  "voice": {
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "modelId": "eleven_turbo_v2_5",
    "stability": 0.5,
    "similarityBoost": 0.75
  },

  "sources": [
    { "id": "src-001", "filePath": "input.mp4", "displayName": "Original recording" }
  ],
  "video": [
    {
      "id": "vid-001",
      "sourceId": "src-001",
      "sourceInSec": 0,
      "sourceOutSec": 120,
      "timelineStartSec": 0
    }
  ],

  "narration": [
    {
      "id": "nar-001",
      "startSec": 0,
      "narration": "Welcome to the demo …",
      "pauseAfterSec": 0,
      "estDurationSec": 4.5,
      "audio": null
    },
    {
      "id": "nar-002",
      "startSec": 4.5,
      "narration": "Here we …",
      "pauseAfterSec": 0,
      "estDurationSec": 3.2,
      "audio": {
        "path": "audio/nar-002.mp3",
        "durationSec": 3.18,
        "renderedAt": "2026-05-27T12:34:56Z",
        "narrationHash": "sha256:..."
      }
    }
  ]
}
```

### Key shape decisions

- **`narration[].audio`** is the red/green flag: `null` = red, populated =
  green. No separate `disabled` flag — to silence a clip, delete it.
- **`narration[].estDurationSec`** is the words-per-second estimate
  (`max(minSec, words / 2.6)`). Refreshed whenever narration text
  changes. Only used for visual width while red.
- **`narration[].audio.narrationHash`** is the hash of the narration
  text at render time. When loaded, if the current narration text
  hashes differently, the UI shows the clip as red (forcing a
  re-render) — this is the "edit invalidates audio" mechanism.
- **`video[]`** drives the underlying footage. `timelineStartSec` =
  where this clip plays in the final timeline; `sourceInSec` /
  `sourceOutSec` = which slice of the source to use. Clips MUST be
  ordered by `timelineStartSec` and MUST NOT overlap (cut-only).
- **`durationSec`** is the max of (last video clip end, last narration
  end + its duration). Computed, not edited by hand.

### Migration

On load, if `timeline.json` is missing but the legacy pair exists:

1. Build `narration[]` from `script.json`: each ScriptSegment becomes a
   NarrationClip with `startSec = scriptSeg.startSec`, narration text
   carried over. If a matching VoiceSegment exists, populate `audio`
   with its `path` + `durationSec` and stamp `narrationHash` from the
   current text (clip starts green even though it predates hashing).
2. Build `sources` = `[{ id: 'src-001', filePath: project.videoPath,
   displayName: project.name }]` and `video` = one clip covering
   `0..durationSec` from that source.
3. Write `timeline.json`.
4. Rename `script.json` → `script.json.bak`, `voice.json` →
   `voice.json.bak`. Keep for one release.

Existing audio files in `audio/` are reused as-is (paths are stable).

## Pipeline stages

| Stage      | Reads                   | Writes               | Notes |
|------------|-------------------------|----------------------|-------|
| `analyze`  | source video            | `analysis.json`      | Unchanged. Still produces detected scene boundaries. |
| `script`   | `analysis.json`         | `timeline.json`      | Claude writes narration text; `startSec` ≈ analysis-segment start; all entries start red. |
| `render`   | `timeline.json`         | `timeline.json` + audio files | NEW. Replaces `voice`. Synthesizes audio for selected red entries (or all). |
| `stitch`   | `timeline.json`         | `out/final.mp4`      | Reads video[] + narration[]. Builds ffmpeg graph with one `-i` per source + concat + audio overlay. |

Backwards compatibility: the old `voice` command stays as an alias for
`render --all` for one release.

## Server endpoints

### New
- `GET  /api/timeline` — current timeline.
- `POST /api/timeline/save` — persist full timeline (used by drag /
  text-edit / etc.).
- `POST /api/timeline/render` — body `{ ids?: string[] }`. If `ids`
  omitted, renders all red clips. Returns the updated timeline.
- `POST /api/sources` — upload a new video source (multipart). Returns
  `{ id, filePath, durationSec }`.

### Kept (for one release)
- `GET /api/voice/clip?id=…` — audio bytes (used by `<audio>` elements).
- `GET /api/voice/clip/peaks?id=…` — waveform peaks.
- `GET /api/video` — source bytes (the single source). Becomes
  `GET /api/sources/:id` in Phase 2 once multi-source lands.

### Deprecated
- `GET /api/script`, `POST /api/script/save`, `POST /api/script` —
  served from the migrated `timeline.json` as a shim during Phase 1,
  removed in Phase 1.4.
- `GET /api/voice`, `POST /api/voice/save`, `POST /api/voice` — same.

## UI

### Audio track

- One row per clip in time order. Blocks positioned by `startSec`
  (percent of timeline duration).
- **Red** (unrendered): dashed border, muted background, label shows
  `est. Ns`. Draggable in time AND in length — the right edge re-fits
  `estDurationSec` (and updates the per-clip pace estimate). Editing
  narration text in the side panel updates `estDurationSec` live.
- **Green** (rendered): solid border, audio-green background, label
  shows the actual `durationSec`. Draggable in time only; width is
  locked. Click "Re-render" in the panel to force re-synthesis.
- **Multi-row layout** (already shipped): overlapping clips stack
  vertically.
- Buttons above the track: "Render selected (1)", "Render all
  unrendered (N)", showing counts.

### Video track

- Above the audio track. One row, fixed height.
- Blocks positioned by `timelineStartSec`, widths by
  `sourceOutSec - sourceInSec`.
- Drag clip *body* to reposition on the timeline.
- Drag clip *endpoints* (l/r handles) to trim — adjusts
  `sourceInSec` / `sourceOutSec` and `timelineStartSec`. The body has
  hard floors (`sourceInSec >= 0`, `sourceOutSec <= source.durationSec`)
  and clips can't overlap each other on the timeline.
- Drop a video file on the track → uploads as a new source, appends a
  clip at the current playhead.
- Click between two clips at the playhead → "split here" splits one
  clip into two with `sourceInSec`/`sourceOutSec` divided at the
  playhead position.

### Removed
- Purple "script segment" track.
- Green/red "voice clip" track (replaced by unified audio track above).
- "Overflow" warning UI (no longer meaningful).
- "Add empty segment" button (replaced by add-narration-on-audio-track).

## Slices

### Phase 1 — unified audio (must ship first)

#### 1.1 — Schema + migration helper (pure-additive)
- Add `TimelineSchema` (and component schemas) to `types.ts`.
- Add `loadTimeline` / `saveTimeline` in `project.ts`.
- Add `migrateLegacyToTimeline(project, script, voice)` as a pure
  function — exposed for tests AND used by `loadTimeline` when
  `timeline.json` is missing.
- Add `narrationHash(text)` + `estimateNarrationDurationSec(text)`
  helpers.
- Tests: migration round-trip, hash stability under cosmetic
  whitespace edits, estimate floor.
- **No caller wired yet.** `loadTimeline` exists but nothing in the
  CLI / server uses it; the legacy `script.json` + `voice.json` files
  remain authoritative. Phase 1.2 atomically (a) switches CLI commands
  to read/write `timeline.json`, (b) rewrites the stitch path against
  the new model, (c) drops the legacy endpoints — this avoids a
  shim layer that would silently change stitch output via derived
  `endSec` values.
- Ships under the existing tile-app behavior with no visible
  differences.

#### 1.2 — Switch CLI + stitch + UI to timeline.json
This is the big slice — it does the actual cutover atomically:
- CLI: `scriptCommand` writes `timeline.json` instead of `script.json`;
  `voiceCommand` (renamed thinking: `render`) updates
  `timeline.narration[*].audio` in place; rewrite `stitchCommand` to
  read `timeline.json` and pass narration entries straight to
  `timing.ts` (the `endSec` window concept is removed from `timing.ts`
  — audio plays at its `startSec` for its `durationSec`, video plays
  independently from `video[*]`).
- Server: add `GET /api/timeline`, `POST /api/timeline/save`,
  `POST /api/timeline/render`. Legacy `GET /api/script` /
  `GET /api/voice` etc. are removed (no shim — there's only one model
  now).
- UI: rewrite `renderClipTrack` / `renderTrack` into one
  `renderAudioTrack`. Drop the purple segment track from the DOM +
  CSS. Add "Render all unrendered" button → POST
  `/api/timeline/render` with empty body. Red blocks use a dashed
  border (new `.unrendered` class); green blocks unchanged.
- Migration runs on first `GET /api/timeline` against an existing
  project (the loadTimeline path from 1.1).

#### 1.3 — Per-clip render + drag-to-resize red + edit invalidation
- Add "Render selected" button (acts on `selectedClipId`).
- Add right-edge resize handle for red clips → updates
  `estDurationSec` and (implicitly) the words-per-second display.
- Narration-text input in the side panel: on `blur`, recompute the
  hash. If text changed since the audio was rendered, set `audio =
  null` (revert to red) and warn in the panel.

#### 1.4 — Final cleanup (SHIPPED)
- ✓ Removed `migrateLegacyToTimeline` + the `.bak` rename logic.
  `loadTimeline` now just reads `timeline.json` (or throws — projects
  that pre-date 1.1 were auto-migrated weeks ago; the pre-1.4 helper
  lives in git history).
- ✓ Removed `loadScript`, `saveScript`, `loadVoice`, `saveVoice` +
  the conversion helpers (`timelineToScript`, `timelineToVoice`,
  `applyScriptToTimeline`, `applyVoiceToTimeline`). Their last
  consumers (the v1 server shim endpoints) were removed in 1.2c.
- ✓ Dropped `ScriptSchema` / `ScriptSegmentSchema` / `Script` type,
  `VoiceManifestSchema` / `VoiceSegmentSchema` / `VoiceManifest`
  type from `types.ts`. `VoiceConfigSchema` survives — it's
  load-bearing for `Timeline.voice`. `SegmentSchema` survives —
  `AnalysisSegmentSchema` extends it.
- ✓ Dropped `FILES.script` / `FILES.voice` constants.
- ✓ Trimmed `timeline.test.ts` — only the load-bearing
  narrationHash + estimateNarrationDurationSec tests remain.

### Phase 2 — multi-clip video (depends on Phase 1.4)

#### 2.1 — Multi-source schema + ffmpeg graph
- Extend `TimelineSchema` with `sources[]` + `video[]`.
- Migration (from Phase 1): wrap the existing single `videoPath` into
  `sources[0]` + `video[0]` covering full duration.
- Rewrite `stitch.ts` / `timing.ts` ffmpeg graph for multi-input
  concat with audio overlay.
- Tests: single-source-passthrough produces identical output to today;
  two-clip cut produces correct frame boundary.

#### 2.2 — Video track UI (single-source clips, no trim)
- New `.video-track` above the audio track. Blocks draggable
  horizontally (no overlap with neighbors).
- Side panel for selected video clip: source name + in/out display
  (read-only for now).
- "Split here" button at playhead.

#### 2.3 — Trim handles + drag
- Left/right edge handles on video clips → updates
  `sourceInSec`/`sourceOutSec` + `timelineStartSec`.
- Bounds: `0 <= sourceInSec < sourceOutSec <= source.durationSec`;
  clips can't overlap.

#### 2.4 — Add source from upload
- Drop file on track → POST `/api/sources` → append clip at playhead.
- Source-picker panel: list `sources[]` with thumbnail + duration;
  drag from picker onto track.

## Risk + open questions

- **R1 — render cost transparency**. Per-clip render makes it easier
  to burn through ElevenLabs quota without realising. Mitigation:
  before render, surface a "≈N chars, ≈$X" estimate (we already do
  this in `voiceCommand`'s cost guard; reuse).
- **R2 — audio file lifecycle**. When a clip turns red after a
  narration edit, the old audio file is orphaned. Strategy: keep it on
  disk (cheap) and let `clean` reap orphans (`audio/` files not
  referenced by any green clip). Document in README.
- **R3 — narration hash stability**. Hash uses the *trimmed,
  whitespace-collapsed* narration text so cosmetic edits don't
  invalidate audio. Tests cover this.
- **R4 — multi-source storage**. Each source is a full video file
  staying in the project dir. No transcoding on upload — let ffmpeg
  handle decoding at stitch time. PVC quota (currently 2Gi per tile)
  may become a limiter for projects with many sources; deferred.
- **R5 — back-compat for migrated audio without `narrationHash`**.
  Migrated clips start green with `narrationHash = hash(current
  narration text)` — i.e. the audio is trusted to match. Acceptable
  because the legacy pair already enforced that one-to-one.

## Versioning

Each slice ships as its own commit + version bump:
- Phase 1.1: MINOR (additive schema, new endpoints).
- Phase 1.2: MINOR (new UI surface).
- Phase 1.3: MINOR.
- Phase 1.4: MAJOR (removes legacy CLI alias + endpoints).
- Phase 2.x: MINOR each, with 2.1 also MAJOR for stitch graph change
  (only matters for downstream consumers that pin the schema).

Tile-app image bumped each slice to deliver the UI changes.

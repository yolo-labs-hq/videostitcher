/**
 * videostitcher tile-app server (TILE_APPS_PLAN P4).
 *
 * A minimal, dependency-free Node HTTP server that drives the videostitcher
 * pipeline (init → analyze → script → voice → stitch → download) programmatically
 * via the library barrel at ../dist/index.js, and serves a single-page UI from
 * ../public/.
 *
 * BYOK (bring-your-own-key) model: the page keeps the user's Gemini / Claude /
 * ElevenLabs keys in memory only and passes them per-request as `apiKey` in the
 * JSON body. The server forwards them straight into the command opts and never
 * persists them. With no key + mock voice, the whole pipeline runs offline.
 *
 * Uses ONLY Node built-ins (no new npm deps). One project per app instance,
 * living at <dataDir>/project; uploads land in <dataDir>/upload.
 */

import http from "node:http";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = Number(process.env.PORT) || 7891;
// Bind on all interfaces by default so the YOLO Studio *.yolopreview.com
// proxy (which reaches the pod via its network IP) can connect. Override
// with HOST=127.0.0.1 for local-only dev (codex Round-17 P2, 2026-05-22).
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.TILEAPP_DATA_DIR || process.env.HOME || process.cwd();

// Multi-project storage (2026-05-26). Each upload creates a new project
// directory under <DATA_DIR>/projects/<projectId>/; the in-memory
// `activeProjectDir` points at whichever project the operator most
// recently selected (or uploaded). All existing per-project endpoints
// (/api/state, /api/analyze, /api/run, /api/stitch, etc.) operate on
// `activeProjectDir`. Older single-project layouts (where one fixed dir
// `<DATA_DIR>/project/` held the only project) are migrated on
// startup to projects/legacy-<ts>/ — the prior behavior wiped the prior
// project on every upload, which made any video browser impossible.
const PROJECTS_ROOT = path.join(DATA_DIR, "projects");
const ACTIVE_PROJECT_FILE = path.join(DATA_DIR, "active-project.json");
const LEGACY_PROJECT_DIR = path.join(DATA_DIR, "project");
// Legacy uploads/ holds raw uploaded videos from the single-project era;
// migrated projects' videoPath still points inside it so we keep it
// readable. New uploads land inside their project dir.

// Project id format: `p-<epoch-ms>-<rand6>` (or `legacy-<ts>-<rand>`
// for migrated legacy data). Path-safe by construction; we still
// regex-validate any id we accept from the wire to defend against
// path traversal (operator-supplied via URL on /select + /delete).
const PROJECT_ID_RE = /^[a-z0-9-]{3,64}$/i;

let activeProjectId = null;
let activeProjectDir = null;

// Lazily import the built library barrel once.
let libPromise;
function lib() {
  if (!libPromise) libPromise = import("../dist/index.js");
  return libPromise;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

// GeminiError (from src/gemini.ts) carries an 800-char snippet of the upstream
// response body — Google's 429 / 4xx bodies name the exact quota or reason
// (e.g. `quotaMetric: ...generate_content_free_tier_input_token_count`).
// Dropping it left operators staring at a bare "(429)" with no recourse.
function richMessage(err) {
  if (!err) return String(err);
  const base = err.message ? String(err.message) : String(err);
  const body = err.body ? String(err.body) : "";
  return body ? `${base} — ${body}` : base;
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error: richMessage(error) });
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBodyBuffer(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── project library (multi-project storage) ────────────────────────────────
//
// PROJECTS_ROOT contains one subdir per project, named by a path-safe
// `p-<epoch-ms>-<rand>` id. The "active project" is the one every
// existing per-project endpoint operates on; the operator selects via
// POST /api/projects/:id/select. Initial active selection on boot is
// persisted to ACTIVE_PROJECT_FILE so the app reopens to the same
// project after a restart.

function isValidProjectId(id) {
  return typeof id === "string" && PROJECT_ID_RE.test(id);
}

function newProjectId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `p-${Date.now()}-${rand}`;
}

function projectPathFor(id) {
  if (!isValidProjectId(id)) return null;
  const resolved = path.join(PROJECTS_ROOT, id);
  // path-traversal sanity check: the joined result must still live
  // inside PROJECTS_ROOT. Defends against any future bypass of
  // isValidProjectId — defense in depth on operator-supplied input.
  if (resolved !== PROJECTS_ROOT && !resolved.startsWith(PROJECTS_ROOT + path.sep)) return null;
  return resolved;
}

/** Best-effort read of <projectDir>/project.json. Returns null on
 *  parse / I/O failure — caller decides whether that's a hard error
 *  (mid-request) or a soft skip (list iteration). */
async function readProjectMeta(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, "project.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Snapshot of which pipeline artifacts exist on disk for a given
 *  project. Mirrors what /api/state returns for the active project. */
async function projectStageFlags(projectDir) {
  const { FILES, projectPath } = await lib();
  const [hasAnalysis, hasTimeline, hasOutput] = await Promise.all([
    exists(projectPath(projectDir, FILES.analysis)),
    exists(projectPath(projectDir, FILES.timeline)),
    exists(projectPath(projectDir, FILES.output)),
  ]);
  return { hasAnalysis, hasTimeline, hasOutput };
}

/** List every project on disk, sorted newest-first by uploadedAt. */
async function listProjects() {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!isValidProjectId(ent.name)) continue;
    const dir = path.join(PROJECTS_ROOT, ent.name);
    const project = await readProjectMeta(dir);
    if (!project) continue; // partially-created or corrupt — skip silently
    const flags = await projectStageFlags(dir);
    let stat;
    try { stat = await fs.stat(dir); } catch { stat = null; }
    out.push({
      id: ent.name,
      name: project.name || ent.name,
      videoPath: project.videoPath || null,
      durationSec: project.durationSec ?? null,
      uploadedAt: stat ? stat.birthtimeMs || stat.mtimeMs : null,
      ...flags,
      isActive: ent.name === activeProjectId,
    });
  }
  out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return out;
}

async function persistActiveProject() {
  try {
    if (activeProjectId) {
      await fs.writeFile(ACTIVE_PROJECT_FILE, JSON.stringify({ projectId: activeProjectId }));
    } else {
      await fs.unlink(ACTIVE_PROJECT_FILE).catch(() => {});
    }
  } catch (err) {
    process.stderr.write(`[projects] failed to persist active-project: ${err}\n`);
  }
}

async function setActiveProject(projectId) {
  if (projectId === null) {
    activeProjectId = null;
    activeProjectDir = null;
    await persistActiveProject();
    return;
  }
  const dir = projectPathFor(projectId);
  if (!dir) throw Object.assign(new Error(`invalid project id: ${projectId}`), { code: "invalid-id" });
  if (!(await exists(dir))) throw Object.assign(new Error(`project not found: ${projectId}`), { code: "not-found" });
  activeProjectId = projectId;
  activeProjectDir = dir;
  await persistActiveProject();
}

/** One-time migration: if a legacy single-project layout exists under
 *  <DATA_DIR>/project/, move it into PROJECTS_ROOT under a stable
 *  `legacy-<ts>` id so the operator's prior work isn't orphaned. The
 *  legacy upload/ directory's loose files are NOT migrated — they
 *  belong to whichever project consumed them, which (in single-project
 *  land) is the one we just relocated.
 *
 *  Idempotent: only runs when projects/ doesn't exist AND project/ does. */
async function migrateLegacyProjectIfPresent() {
  const projectsExists = await exists(PROJECTS_ROOT);
  if (projectsExists) return; // already migrated or never had legacy
  const legacyExists = await exists(LEGACY_PROJECT_DIR);
  if (!legacyExists) return; // nothing to migrate
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  const legacyId = `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const target = path.join(PROJECTS_ROOT, legacyId);
  try {
    await fs.rename(LEGACY_PROJECT_DIR, target);
    process.stdout.write(`[projects] migrated legacy single-project layout → projects/${legacyId}\n`);
  } catch (err) {
    process.stderr.write(`[projects] legacy migration failed (continuing without it): ${err}\n`);
  }
}

/** Boot-time init: migrate legacy data, pick an active project. Order
 *  of preference for the active selection:
 *    1. ACTIVE_PROJECT_FILE's projectId (if its dir still exists)
 *    2. most-recent project on disk (so a fresh boot lands on the
 *       last-uploaded project even if active-project.json is missing)
 *    3. none (active stays null; the UI shows its upload-prompt
 *       empty state). */
async function initProjectsLibrary() {
  await migrateLegacyProjectIfPresent();
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  try {
    const raw = await fs.readFile(ACTIVE_PROJECT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && isValidProjectId(parsed.projectId)) {
      const dir = projectPathFor(parsed.projectId);
      if (dir && (await exists(dir))) {
        activeProjectId = parsed.projectId;
        activeProjectDir = dir;
        return;
      }
    }
  } catch {
    /* no active-project.json or unparseable — fall through */
  }
  // Fall back to most-recent on disk so a reboot doesn't strand the
  // operator's last project (the previous behavior implicitly did
  // this — there was only ever one project).
  const all = await listProjects();
  if (all.length > 0) {
    const id = all[0].id;
    const dir = projectPathFor(id);
    if (dir) { activeProjectId = id; activeProjectDir = dir; }
  }
}

// ── project library endpoint handlers ─────────────────────────────────────

// GET /api/projects — every project on disk + which one is active.
async function handleListProjects(req, res) {
  const projects = await listProjects();
  sendJson(res, 200, { ok: true, projects, activeProjectId });
}

// GET /api/projects/:id/poster — single-frame thumbnail for the library
// UI. Lazy-generated on first request (ffmpeg grabs the frame at the
// 1-second mark, downscaled to 160×90) and cached at <projectDir>/poster.jpg.
// 160×90 matches the strip-thumbnail dimensions so layout assumptions hold
// across the rest of the app. Slice 3 of the multi-project library
// workstream.
const POSTER_WIDTH = 160;
const POSTER_HEIGHT = 90;
const posterInflight = new Map(); // projectId → Promise<string>  (dedup concurrent generations)

async function generatePoster(projectDir) {
  const project = await readProjectMeta(projectDir);
  if (!project?.videoPath) throw Object.assign(new Error("project has no video"), { code: "no-video" });
  const videoPath = path.resolve(String(project.videoPath));
  let videoStat;
  try { videoStat = await fs.stat(videoPath); }
  catch { throw Object.assign(new Error("source video missing"), { code: "no-video" }); }
  if (!videoStat.isFile()) throw Object.assign(new Error("source video is not a file"), { code: "no-video" });

  await resolveFfmpegBin();
  const posterPath = path.join(projectDir, "poster.jpg");
  const tmpPath = posterPath.replace(/\.jpg$/, `.tmp.${process.pid}.jpg`);
  const filter =
    `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${POSTER_WIDTH}:${POSTER_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;
  try {
    await ffmpegRun([
      "-nostdin", "-v", "error", "-y",
      // Seek to 1s before -i (input-seek, faster than output-seek for
      // single-frame grabs) — avoids black frames at the very start
      // of screen recordings.
      "-ss", "1",
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", filter,
      "-q:v", "5",
      tmpPath,
    ]);
    await fs.rename(tmpPath, posterPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* */ }
    throw err;
  }
  return posterPath;
}

async function handleProjectPoster(req, res, projectId) {
  const dir = projectPathFor(projectId);
  if (!dir) return fail(res, 400, "invalid project id");
  if (!(await exists(dir))) return fail(res, 404, "project not found");
  const posterPath = path.join(dir, "poster.jpg");

  let posterStat;
  try { posterStat = await fs.stat(posterPath); }
  catch { posterStat = null; }
  if (!posterStat) {
    // Dedup concurrent generations for the same project — multiple
    // library rows mount the <img> in parallel and would otherwise
    // each spawn ffmpeg.
    let inflight = posterInflight.get(projectId);
    if (!inflight) {
      inflight = generatePoster(dir).finally(() => posterInflight.delete(projectId));
      posterInflight.set(projectId, inflight);
    }
    try { await inflight; }
    catch (err) {
      if (err && err.code === "no-video") return fail(res, 404, err);
      process.stderr.write(`[poster] generation failed for ${projectId}: ${err && err.stack ? err.stack : err}\n`);
      return fail(res, 500, err);
    }
    try { posterStat = await fs.stat(posterPath); }
    catch { return fail(res, 500, "poster vanished after generation"); }
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": posterStat.size,
    // Per-project ETag-style cache invalidation isn't needed — poster.jpg
    // is content-addressed to the project's first-second frame, which
    // doesn't change once generated. Use a short max-age so library
    // re-renders are snappy.
    "Cache-Control": "private, max-age=300",
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(posterPath);
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
  stream.pipe(res);
}

// POST /api/projects/:id/select — switch the active project.
async function handleSelectProject(req, res, projectId) {
  try {
    await setActiveProject(projectId);
  } catch (err) {
    return fail(res, err.code === "invalid-id" ? 400 : err.code === "not-found" ? 404 : 500, err);
  }
  // Mirror the /api/state shape so the UI can refresh without an extra round-trip.
  return handleState(req, res);
}

// POST /api/projects/:id/rename — { name } updates project.json.name.
// Used by the Library row inline-rename + active-project name editor;
// per Phase 2 the project name + the source-video filename are separate
// concerns (a project may end up stitching multiple sources).
async function handleRenameProject(req, res, projectId) {
  const dir = projectPathFor(projectId);
  if (!dir) return fail(res, 400, "invalid project id");
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return fail(res, 400, `invalid JSON body: ${err.message || err}`); }
  const incoming = typeof body?.name === "string" ? body.name.trim() : "";
  if (!incoming) return fail(res, 400, "name is required and must be a non-empty string");
  if (incoming.length > 200) return fail(res, 400, "name is too long (max 200 chars)");
  const { loadProject, saveProject } = await lib();
  let project;
  try { project = await loadProject(dir); }
  catch (err) { return fail(res, 404, `project.json not found: ${err.message || err}`); }
  const next = { ...project, name: incoming };
  try { await saveProject(dir, next); }
  catch (err) { return fail(res, 500, err); }
  sendJson(res, 200, { ok: true, project: next });
}

// DELETE /api/projects/:id — remove a project (idempotent on success).
// If the deleted project was active, fall back to the most-recent
// remaining project (or null if none).
async function handleDeleteProject(req, res, projectId) {
  const dir = projectPathFor(projectId);
  if (!dir) return fail(res, 400, "invalid project id");
  const wasActive = projectId === activeProjectId;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    return fail(res, 500, err);
  }
  if (wasActive) {
    const all = await listProjects();
    if (all.length > 0) {
      const nextId = all[0].id;
      const nextDir = projectPathFor(nextId);
      if (nextDir) { activeProjectId = nextId; activeProjectDir = nextDir; }
    } else {
      activeProjectId = null;
      activeProjectDir = null;
    }
    await persistActiveProject();
  }
  sendJson(res, 200, { ok: true, deleted: projectId, activeProjectId });
}

// ── SSE helpers ────────────────────────────────────────────────────────────
function openSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (Cloudflare / NGINX) so per-stage frames flush
    // immediately — otherwise the UI sits on the first event until the whole
    // pipeline finishes.
    "X-Accel-Buffering": "no",
  });
  // Initial flush so the browser sees the response headers right away.
  res.write(": ok\n\n");
  // Heartbeat to keep idle proxies from timing out long ElevenLabs calls.
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
  const close = () => clearInterval(hb);
  req.on("close", close);
  res.on("close", close);
  return {
    send(event, data) {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* connection gone — best-effort */
      }
    },
    end() {
      clearInterval(hb);
      try { res.end(); } catch {}
    },
  };
}

// Serialize concurrent /api/run invocations against a single project on disk —
// the stages mutate analysis.json / script.json / voice.json and ffmpeg child
// processes don't appreciate two analyzes racing. First caller wins; second
// gets a 409.
let runInFlight = false;

// ── static file serving (path-traversal guarded) ───────────────────────────
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, "forbidden");
  }
  try {
    const data = await fs.readFile(resolved);
    const type = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  } catch {
    fail(res, 404, "not found");
  }
}

// ── route handlers ──────────────────────────────────────────────────────────

/**
 * Stream `req` to `dest` with a hard byte cap. Resolves to the bytes written
 * on success; rejects with { code: 'too-large' } if the cap is exceeded
 * (codex Round-19 P2a, 2026-05-22 — was buffering the whole upload in memory
 * and could OOM the app process for a multi-hundred-MB screencast).
 */
function streamUploadToFile(req, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let aborted = false;
    const out = createWriteStream(dest);
    const abort = (err) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(out);
      out.destroy();
      fs.unlink(dest).catch(() => { /* */ });
      reject(err);
    };
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) abort(Object.assign(new Error(`upload exceeds ${maxBytes} bytes`), { code: "too-large" }));
    });
    req.on("error", abort);
    out.on("error", abort);
    out.on("finish", () => { if (!aborted) resolve(bytes); });
    req.pipe(out);
  });
}

const UPLOAD_MAX_BYTES = Number(process.env.TILEAPP_UPLOAD_MAX_BYTES) || 500 * 1024 * 1024; // 500 MB default

// POST /api/upload — raw video bytes in the body; filename via ?name= or X-Filename.
async function handleUpload(req, res, url) {
  const { initCommand, loadProject } = await lib();
  const rawName = url.searchParams.get("name") || req.headers["x-filename"] || "screencast.mp4";
  const filename = path.basename(String(rawName)) || "screencast.mp4";

  // Each upload creates a brand-new project under PROJECTS_ROOT — never
  // wipes the prior project. The video file lives inside the project
  // dir so deleting the project removes its video too.
  const newId = newProjectId();
  const projectDir = projectPathFor(newId);
  if (!projectDir) return fail(res, 500, "internal: generated invalid project id");
  await fs.mkdir(projectDir, { recursive: true });
  const videoPath = path.join(projectDir, filename);
  let bytes;
  try {
    bytes = await streamUploadToFile(req, videoPath, UPLOAD_MAX_BYTES);
  } catch (err) {
    // Clean up the half-created project dir on upload failure so /api/projects
    // doesn't accumulate empty stubs.
    try { await fs.rm(projectDir, { recursive: true, force: true }); } catch { /* */ }
    if (err && err.code === "too-large") return fail(res, 413, err);
    return fail(res, 500, err);
  }
  if (bytes === 0) {
    try { await fs.rm(projectDir, { recursive: true, force: true }); } catch { /* */ }
    return fail(res, 400, "empty upload body");
  }

  // Scaffold the project (writes project.json with the video path).
  await initCommand(videoPath, { dir: projectDir, name: path.parse(filename).name });
  const project = await loadProject(projectDir);

  // Switch active to the freshly-uploaded project so all existing
  // per-project endpoints (/api/state, /api/analyze, /api/run, etc.)
  // operate on it. The UI's existing post-upload flow expects this.
  activeProjectId = newId;
  activeProjectDir = projectDir;
  await persistActiveProject();

  sendJson(res, 200, { ok: true, projectId: newId, durationSec: undefined, project });
}

// ── import from the workspace filesystem ────────────────────────────────────
//
// When the server runs WITH access to the workspace filesystem (e.g. the
// screencast rig and this server share a session pod), it can ingest a video
// that already lives on disk — no re-upload of bytes. Imports are confined to
// an allow-list of roots (VIDEOSTITCHER_IMPORT_ROOTS, ':'-separated; default
// the screencast rig's output dir) so an operator can only pull videos from
// known locations. The sandboxed tile-app build (bwrap, /data only) can't see
// these roots — that path needs a broker fs.read capability (tracked
// separately); this is the local/workspace-server path.
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v"]);
// Default tracks where the screencast rig writes takes: the workspace dir when
// WORKSPACE_PATH is known (local/dev runs) plus legacy /tmp. In the bwrap build
// neither is visible directly — production import goes via the broker
// (TILEAPP_FS_READ_ROOTS), which is kept in lockstep with this default.
const DEFAULT_IMPORT_ROOTS = [
  process.env.WORKSPACE_PATH ? `${process.env.WORKSPACE_PATH}/cam-rig` : null,
  "/tmp/cam-rig",
].filter(Boolean).join(":");
const IMPORT_ROOTS = (process.env.VIDEOSTITCHER_IMPORT_ROOTS || DEFAULT_IMPORT_ROOTS)
  .split(":").map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));

function isUnderImportRoot(resolved) {
  return IMPORT_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

async function listWorkspaceVideos() {
  const out = [];
  for (const root of IMPORT_ROOTS) {
    if (!(await exists(root))) continue;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length && out.length < 200) {
      const { dir, depth } = stack.pop();
      let ents = [];
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 5) stack.push({ dir: full, depth: depth + 1 }); continue; }
        if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
          try {
            const st = await fs.stat(full);
            // Report whether a foley sidecar (inputs.json — timing-only
            // click/keypress data) sits next to this take so the importer
            // can badge it and the local path knows to copy it across.
            const hasSidecar = await exists(path.join(path.dirname(full), "inputs.json"));
            out.push({ path: full, name: e.name, sizeBytes: st.size, mtimeMs: st.mtimeMs, hasSidecar });
          } catch { /* skip unreadable */ }
        }
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, 200);
}

// GET /api/workspace-videos — list importable videos under the allow-listed roots.
async function handleWorkspaceVideos(req, res) {
  const videos = await listWorkspaceVideos();
  sendJson(res, 200, { ok: true, roots: IMPORT_ROOTS, videos });
}

// POST /api/import-from-workspace { path } — copy a workspace video into a new
// project (mirrors /api/upload, but the bytes come from a local path, not the body).
async function handleImportFromWorkspace(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return fail(res, 400, err); }
  const src = String(body && body.path || "");
  if (!src) return fail(res, 400, "path required");
  const resolved = path.resolve(src);
  if (!isUnderImportRoot(resolved)) return fail(res, 403, "path is outside the allowed import roots");
  if (!VIDEO_EXTS.has(path.extname(resolved).toLowerCase())) return fail(res, 400, "not a video file");
  let st;
  try { st = await fs.stat(resolved); } catch { return fail(res, 404, "file not found"); }
  if (!st.isFile()) return fail(res, 400, "not a regular file");

  const { initCommand, loadProject } = await lib();
  const newId = newProjectId();
  const projectDir = projectPathFor(newId);
  if (!projectDir) return fail(res, 500, "internal: generated invalid project id");
  await fs.mkdir(projectDir, { recursive: true });
  const filename = path.basename(resolved);
  const videoPath = path.join(projectDir, filename);
  try {
    await fs.copyFile(resolved, videoPath);
  } catch (err) {
    try { await fs.rm(projectDir, { recursive: true, force: true }); } catch { /* */ }
    return fail(res, 500, err);
  }

  // Foley sidecar: screencast takes write an inputs.json (click/keypress
  // timestamps, no content) next to the mp4. Ride it along under the
  // `<video minus ext>.inputs.json` convention foley.ts looks for, so the
  // stitch can auto-mix click/key sounds. Best-effort — most imports are
  // plain videos with no sidecar.
  try {
    const sidecarSrc = path.join(path.dirname(resolved), "inputs.json");
    const st2 = await fs.stat(sidecarSrc);
    if (st2.isFile()) {
      const base = videoPath.slice(0, -path.extname(videoPath).length);
      await fs.copyFile(sidecarSrc, `${base}.inputs.json`);
    }
  } catch { /* no sidecar — fine */ }

  await initCommand(videoPath, { dir: projectDir, name: path.parse(filename).name });
  const project = await loadProject(projectDir);
  activeProjectId = newId;
  activeProjectDir = projectDir;
  await persistActiveProject();
  sendJson(res, 200, { ok: true, projectId: newId, source: resolved, project });
}

// Foley sidecars are tiny (timing-only event lists — a couple hundred KB at
// most). Cap well below the video ceiling so a mislabelled call can't stream a
// huge body into a project dir.
const SIDECAR_MAX_BYTES = Number(process.env.VIDEOSTITCHER_SIDECAR_MAX_BYTES) || 16 * 1024 * 1024; // 16 MB

// POST /api/upload-sidecar?projectId=&videoName= — raw inputs.json bytes in the
// body; writes the foley sidecar next to the project's video under the
// `<video minus ext>.inputs.json` name foley.ts resolves. This is the sandboxed
// tile-app's sidecar path: the capability broker reads one file at a time and
// can't copy sibling files, so the client reads the take's inputs.json via the
// bridge and POSTs it here AFTER the mp4 upload created the project. Best-effort
// by contract — a take with no sidecar simply never calls this.
async function handleUploadSidecar(req, res, url) {
  const projectId = String(url.searchParams.get("projectId") || "");
  const projectDir = projectPathFor(projectId);
  if (!projectDir) return fail(res, 400, "invalid or missing projectId");
  if (!(await exists(projectDir))) return fail(res, 404, "project not found");
  const rawVideo = url.searchParams.get("videoName") || req.headers["x-video-name"] || "";
  const videoName = path.basename(String(rawVideo));
  if (!videoName) return fail(res, 400, "videoName required");
  const ext = path.extname(videoName);
  const base = ext ? videoName.slice(0, -ext.length) : videoName;
  const dest = path.join(projectDir, `${base}.inputs.json`);
  let bytes;
  try {
    bytes = await streamUploadToFile(req, dest, SIDECAR_MAX_BYTES);
  } catch (err) {
    try { await fs.rm(dest, { force: true }); } catch { /* */ }
    if (err && err.code === "too-large") return fail(res, 413, err);
    return fail(res, 500, err);
  }
  if (bytes === 0) {
    try { await fs.rm(dest, { force: true }); } catch { /* */ }
    return fail(res, 400, "empty sidecar body");
  }
  // Validate it parses as JSON — foley load is best-effort and swallows a bad
  // sidecar silently, so fail loud here at import time instead of shipping a
  // corrupt file that produces no foley with no explanation.
  try { JSON.parse(await fs.readFile(dest, "utf8")); }
  catch (err) {
    try { await fs.rm(dest, { force: true }); } catch { /* */ }
    return fail(res, 400, `sidecar is not valid JSON: ${err.message || err}`);
  }
  sendJson(res, 200, { ok: true, projectId, sidecar: path.basename(dest), sizeBytes: bytes });
}

// POST /api/sources — raw video bytes for an ADDITIONAL source (multi-clip
// editing, Phase 2.4). Filename via ?name= or X-Filename. The bytes land
// at <activeProjectDir>/sources/<sourceId>.<ext>, the file is ffprobe'd
// for duration, a new entry is appended to timeline.sources, and a new
// clip covering the full source is appended to timeline.video so the
// upload is immediately visible on the track. /api/upload remains the
// "fresh project from a single video" endpoint; this one is for adding
// material to an EXISTING project.
async function handleAddSource(req, res, url) {
  const { loadTimeline, saveTimeline } = await lib();
  const rawName = url.searchParams.get("name") || req.headers["x-filename"] || "source.mp4";
  const filename = path.basename(String(rawName)) || "source.mp4";
  const ext = path.extname(filename) || ".mp4";
  let timeline;
  try { timeline = await loadTimeline(activeProjectDir); }
  catch (err) { return fail(res, 409, `no timeline to add a source to — run script first: ${err.message || err}`); }

  // Pick a fresh source id by scanning existing ones for the highest
  // src-NNN suffix and incrementing.
  const used = new Set(timeline.sources.map((s) => s.id));
  let n = timeline.sources.length + 1;
  while (used.has(`src-${String(n).padStart(3, "0")}`)) n++;
  const newId = `src-${String(n).padStart(3, "0")}`;

  const sourcesDir = path.join(activeProjectDir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  // Use the new source id as the on-disk filename so the path is
  // collision-free across re-uploads under the same display name.
  const sourceFile = path.join(sourcesDir, `${newId}${ext}`);
  let bytes;
  try {
    bytes = await streamUploadToFile(req, sourceFile, UPLOAD_MAX_BYTES);
  } catch (err) {
    try { await fs.unlink(sourceFile); } catch { /* */ }
    if (err && err.code === "too-large") return fail(res, 413, err);
    return fail(res, 500, err);
  }
  if (bytes === 0) {
    try { await fs.unlink(sourceFile); } catch { /* */ }
    return fail(res, 400, "empty upload body");
  }

  // Probe duration so the trim handles know the upper bound and the new
  // clip covers the full source.
  let durationSec;
  try {
    await resolveFfprobeBin();
    durationSec = await probeVideoDuration(sourceFile);
  } catch (err) {
    // Probe failed but the file landed — let the operator decide what
    // to do. Keep the file on disk + add the source without a duration;
    // trim handles fall through to Infinity until the file is re-probed.
    process.stderr.write(`[sources] probe failed for ${sourceFile}: ${err && err.message || err}\n`);
  }

  // Append the source + a clip covering its full window at the END of
  // the timeline (back-to-back with the last existing clip).
  const displayName = path.parse(filename).name;
  timeline.sources.push({
    id: newId,
    filePath: sourceFile,
    displayName,
    ...(typeof durationSec === "number" && durationSec > 0 ? { durationSec } : {}),
  });
  // The new clip's timelineStartSec is the cumulative end of all prior
  // clips — reflowVideoClips() (UI-side) handles all of that on its end,
  // but server-side we still need to write a valid value so the planner
  // accepts the saved manifest. Compute it here.
  // Append onto the project's OCCUPIED lane, not unconditionally lane 0 —
  // otherwise a project whose clips were all moved to one non-zero lane would
  // gain a stray lane-0 clip and trip the multi-lane export gate. If the
  // project is already multi-lane (preview-only) fall back to lane 0. Cumulative
  // end is the per-lane cursor in OUTPUT (played) seconds (honors clip speed).
  const trackOf = (c) => (typeof c.track === "number" && c.track > 0 ? Math.floor(c.track) : 0);
  const usedTracks = [...new Set(timeline.video.map(trackOf))];
  const targetTrack = usedTracks.length === 1 ? usedTracks[0] : 0;
  let cursor = 0;
  for (const v of timeline.video) {
    if (trackOf(v) !== targetTrack) continue;
    cursor += (v.sourceOutSec - v.sourceInSec) / (v.speed && v.speed > 0 ? v.speed : 1);
  }
  const newClipId = `vid-${String(timeline.video.length + 1).padStart(3, "0")}`;
  const clipSpan = typeof durationSec === "number" && durationSec > 0 ? durationSec : 30; // fallback
  timeline.video.push({
    id: newClipId,
    sourceId: newId,
    sourceInSec: 0,
    sourceOutSec: clipSpan,
    timelineStartSec: cursor,
    speed: 1,
    ...(targetTrack > 0 ? { track: targetTrack } : {}),
  });
  // durationSec is a derived field but persisted. Recompute (target lane end).
  timeline.durationSec = cursor + clipSpan;
  await saveTimeline(activeProjectDir, timeline);
  sendJson(res, 200, { ok: true, timeline, sourceId: newId, clipId: newClipId, durationSec });
}

// Audio file extensions accepted as an uploaded voiceover / music bed. The
// browser also pre-filters via <input accept>, but the server is the real
// gate. Mirrors AUDIO_MIME (the serve side) so anything we accept we can
// stream back for preview.
const UPLOAD_AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);

// POST /api/audio — raw audio bytes for an uploaded narration clip (music bed
// or pre-recorded voiceover). Filename via ?name= / X-Filename; lane via
// ?track=; placement via ?startSec=. The bytes land at
// <activeProjectDir>/audio/<aud-NNN>.<ext>, the file is ffprobe'd for
// duration, and a GREEN narration clip (audio already populated, source:
// "upload") is appended to timeline.narration so it shows up immediately —
// no render step, no ElevenLabs. The render stages never touch it (they key
// on narration text + narrationHash; an upload has neither).
async function handleUploadAudio(req, res, url) {
  const { loadTimeline, saveTimeline, FILES } = await lib();
  const rawName = url.searchParams.get("name") || req.headers["x-filename"] || "audio.mp3";
  const filename = path.basename(String(rawName)) || "audio.mp3";
  const ext = (path.extname(filename) || "").toLowerCase();
  if (!UPLOAD_AUDIO_EXTS.has(ext)) {
    return fail(res, 415, `unsupported audio type "${ext || "(none)"}" — use mp3, wav, m4a, aac, ogg, opus, or flac`);
  }
  let timeline;
  try { timeline = await loadTimeline(activeProjectDir); }
  catch (err) { return fail(res, 409, `no timeline to add audio to — create a project first: ${err.message || err}`); }

  const track = Math.max(0, Math.floor(Number(url.searchParams.get("track")) || 0));
  const startSec = Math.max(0, Number(url.searchParams.get("startSec")) || 0);

  // Fresh narration id whose on-disk file is ALSO unreferenced. A split clip
  // shares its source clip's audio.path under a different id, so a recycled id
  // (after the original was deleted) could otherwise pick a basename a split
  // sibling still points at and overwrite it on upload. Skip any k whose id is
  // in use OR whose target file `aud-NNN.<ext>` is referenced by ANY narration
  // clip's audio.path.
  const usedIds = new Set(timeline.narration.map((n) => n.id));
  const usedAudioBasenames = new Set(
    timeline.narration
      .map((n) => (n.audio && typeof n.audio.path === "string" ? path.basename(n.audio.path) : null))
      .filter(Boolean),
  );
  let k = 1;
  const idFor = (i) => `aud-${String(i).padStart(3, "0")}`;
  while (usedIds.has(idFor(k)) || usedAudioBasenames.has(`${idFor(k)}${ext}`)) k++;
  const newId = idFor(k);

  const audioDir = path.join(activeProjectDir, FILES.audioDir);
  await fs.mkdir(audioDir, { recursive: true });
  const audioFile = path.join(audioDir, `${newId}${ext}`);
  let bytes;
  try {
    bytes = await streamUploadToFile(req, audioFile, UPLOAD_MAX_BYTES);
  } catch (err) {
    try { await fs.unlink(audioFile); } catch { /* */ }
    if (err && err.code === "too-large") return fail(res, 413, err);
    return fail(res, 500, err);
  }
  if (bytes === 0) {
    try { await fs.unlink(audioFile); } catch { /* */ }
    return fail(res, 400, "empty upload body");
  }

  // Probe duration (ffprobe reports container duration for audio too). A
  // failed probe is fatal here, unlike video: a narration clip with no audio
  // duration has no footprint on the timeline and would be invisible.
  let durationSec;
  try {
    await resolveFfprobeBin();
    durationSec = await probeVideoDuration(audioFile);
  } catch (err) {
    try { await fs.unlink(audioFile); } catch { /* */ }
    return fail(res, 422, `could not read audio duration — file may be corrupt: ${err && err.message || err}`);
  }
  if (!(durationSec > 0)) {
    try { await fs.unlink(audioFile); } catch { /* */ }
    return fail(res, 422, "audio has zero/unknown duration");
  }

  // GREEN clip: audio already present, so the editor renders it rendered. Path
  // is stored RELATIVE to the project dir (same convention as a TTS render);
  // /api/voice/clip resolves + pins it under activeProjectDir.
  timeline.narration.push({
    id: newId,
    startSec,
    narration: "",
    pauseAfterSec: 0,
    estDurationSec: durationSec,
    audio: {
      path: path.join(FILES.audioDir, `${newId}${ext}`),
      durationSec,
      renderedAt: new Date().toISOString(),
      source: "upload",
    },
    ...(track > 0 ? { track } : {}),
  });
  // Persist the lane so an upload onto a new bottom lane survives reload, and
  // grow the derived total duration if this clip extends past the current end.
  if (track > 0) timeline.audioLaneCount = Math.max(Number(timeline.audioLaneCount) || 1, track + 1);
  timeline.durationSec = Math.max(Number(timeline.durationSec) || 0, startSec + durationSec);

  await saveTimeline(activeProjectDir, timeline);
  sendJson(res, 200, { ok: true, timeline, clipId: newId, durationSec });
}

// POST /api/analyze — { apiKey?, fps?, force? } → Gemini analysis.
// Reuse-by-default: the underlying analyzeCommand short-circuits and
// returns the existing analysis.json when present. Pass force:true (the
// UI's "Re-analyze" button) to overwrite and re-bill Gemini.
async function handleAnalyze(req, res) {
  const { analyzeCommand } = await lib();
  let body;
  try { body = await readJsonBody(req); } catch (e) { return fail(res, 400, e); }
  if (!activeProjectDir) return fail(res, 409, "no active project");
  const opts = {};
  if (body.apiKey) opts.apiKey = String(body.apiKey);
  if (body.fps != null) opts.fps = Number(body.fps);
  if (body.force === true) opts.force = true;
  // Stream over SSE (same as /api/run) instead of a single blocking response.
  // Gemini upload+process+generate on a multi-minute video runs longer than
  // the tile's front proxy allows for a buffered request, so a plain POST
  // returned 504 to the browser even though the analysis completed. openSse
  // flushes headers immediately + heartbeats every 15s, keeping the proxy from
  // timing the connection out. The work itself is unchanged.
  const sse = openSse(req, res);
  sse.send("analyze", { status: "started" });
  try {
    const analysis = await analyzeCommand(activeProjectDir, opts);
    sse.send("analyze", { status: "completed", segments: analysis?.segments?.length ?? 0 });
    sse.send("done", { ok: true });
  } catch (err) {
    sse.send("error", { error: String((err && err.message) || err) });
  } finally {
    sse.end();
  }
}

// POST /api/script — { apiKey? } → Claude draft into timeline.json; falls
// back to analysis-derived draft when no key. The result is a timeline with
// every narration entry RED (audio: null) — the operator triggers
// /api/timeline/render to populate audio per-clip or in bulk.
async function handleScriptDraft(req, res) {
  const {
    scriptCommand,
    buildTimelineFromAnalysis,
    loadAnalysis,
    loadProject,
    loadTimeline,
    saveTimeline,
  } = await lib();
  let body;
  try { body = await readJsonBody(req); } catch (e) { return fail(res, 400, e); }
  if (!activeProjectDir) return fail(res, 409, "no active project");
  const apiKey = body.apiKey ? String(body.apiKey) : undefined;

  // Stream over SSE (same as /api/analyze, /api/run) — the Claude draft call
  // runs long enough to 504 behind the tile's buffering front proxy as a plain
  // POST. openSse flushes headers immediately + heartbeats. Work is unchanged.
  const sse = openSse(req, res);
  sse.send("script", { status: "started" });
  try {
    let usedFallback = false;
    try {
      // apiKey may be undefined — scriptCommand → claude.ts makeClient resolves
      // the workspace env key (VIDEOSTITCHER_ANTHROPIC_API_KEY), so Claude is
      // used whenever a key is reachable without the browser re-sending it (the
      // UI hides the key field when the env key is present, so it never would).
      // Throws if NO key is resolvable OR Claude fails → analysis-derived draft.
      await scriptCommand(activeProjectDir, { apiKey, force: true });
    } catch (err) {
      process.stderr.write(`[script] Claude stage unavailable, using analysis-derived draft: ${err}\n`);
      usedFallback = true;
    }

    if (usedFallback) {
      // No-LLM fallback: synthesize a placeholder draft from the analysis
      // (suggested beat / visual summary as narration) and build the timeline.
      const [project, analysis] = await Promise.all([
        loadProject(activeProjectDir),
        loadAnalysis(activeProjectDir),
      ]);
      const draft = {
        segments: analysis.segments.map((s) => ({
          id: s.id,
          narration: (s.suggestedBeat || s.visualSummary || "").trim(),
          pauseAfterSec: 0,
        })),
      };
      const { timeline } = buildTimelineFromAnalysis(project, analysis, draft);
      await saveTimeline(activeProjectDir, timeline);
    }

    await loadTimeline(activeProjectDir); // confirm it's readable before reporting done
    sse.send("script", { status: "completed", usedFallback });
    sse.send("done", { ok: true });
  } catch (err) {
    sse.send("error", { error: String((err && err.message) || err) });
  } finally {
    sse.end();
  }
}

// POST /api/narration/help — "Help me write" AI voiceover assist for a single
// narration clip. Body: { mode, clipId?, text?, prompt?, apiKey? }.
//   - mode 'improve': rewrite `text` (or the clip's narration looked up by
//     clipId) into tighter, conversational screencast VO.
//   - mode 'prompt' : draft fresh narration from the free-text `prompt`.
// When the project has analysis.json AND a clipId resolves to a clip, the
// handler derives sceneContext (analysis segments overlapping the clip's time
// window) + neighborContext (prev/next clips' narration) and folds them into
// the prompt. Absent analysis or timeline → text-only, still works.
//
// Unlike /api/script this is a quick single-line call, so it's a plain
// buffered JSON response (no SSE) — Opus on a 2k-token cap returns fast.

// Map an OUTPUT-timeline second to a SOURCE-video second through the video edit.
// analysis.segments are timestamped against the ORIGINAL source video, but a
// narration clip's startSec is an OUTPUT-timeline time. Once the operator trims,
// reorders, or speed-ramps the video the two diverge, so look up the video clip
// whose played window contains `outSec` and invert its mapping:
//   srcSec = sourceInSec + (outSec − timelineStartSec) * speed
// (the inverse of foley's remap). Returns null when no clip covers `outSec`
// (narration in a gap / past the video) so the caller falls back to the raw
// output time — which is also exactly right for the common single
// untrimmed-clip project, where output time == source time.
//
// The window is half-open [start, start+played): a point exactly on an edit
// boundary belongs to the LATER clip (so a narration whose in-point sits at a
// cut maps to the next clip's source-start, not the previous clip's end). For
// an END lookup, nudge the time just inside the window so it resolves into the
// clip the narration plays through, not the one after the cut.
//
// Returns a descriptor of the video clip whose PLAYED window contains `outSec`
// — { v, speed, start, played } — or null when no clip covers the point (gap /
// past the video). The caller needs the whole clip (not just a mapped second)
// to (a) check the clip's source identity — analysis.json describes only the
// ORIGINAL source, so a multi-source project must not feed added-footage time
// into it — and (b) clamp a narration's scene window WITHIN this one shot, so a
// VO that spans a cut isn't mapped into a bogus source range jumping across the
// edit.
function coveringVideoClip(timeline, outSec) {
  const vids = timeline && Array.isArray(timeline.video) ? timeline.video : [];
  const EPS = 1e-6;
  let best = null;
  for (const v of vids) {
    const speed = v.speed && v.speed > 0 ? v.speed : 1;
    const played = (v.sourceOutSec - v.sourceInSec) / speed;
    const start = v.timelineStartSec || 0;
    if (outSec >= start - EPS && outSec < start + played) {
      const track = typeof v.track === "number" && v.track > 0 ? Math.floor(v.track) : 0;
      // Highest track wins — where video lanes overlap, the preview shows the
      // top lane (z-order, matching segAt()), so scene context must come from
      // the clip actually visible, not the first one in array order.
      if (!best || track > best.track) best = { v, speed, start, played, track };
    }
  }
  return best;
}
// Output-second → source-second within a known covering clip (inverse of foley's
// remap): srcSec = sourceInSec + (outSec − timelineStartSec) * speed.
function srcSecIn(cover, outSec) {
  return cover.v.sourceInSec + (outSec - cover.start) * cover.speed;
}

async function handleNarrationHelp(req, res) {
  const { helpWriteNarration, deriveSceneContext, loadAnalysis, loadTimeline } = await lib();

  let body;
  try { body = await readJsonBody(req); } catch (e) { return fail(res, 400, e); }
  if (!activeProjectDir) return fail(res, 409, "no active project");

  const mode = body.mode;
  if (mode !== "improve" && mode !== "prompt") {
    return fail(res, 400, "mode must be 'improve' or 'prompt'");
  }
  const apiKey = body.apiKey ? String(body.apiKey) : undefined;
  const clipId = body.clipId != null ? String(body.clipId) : undefined;
  const promptText = body.prompt != null ? String(body.prompt) : undefined;

  // Key resolution mirrors /api/script: body.apiKey OR the workspace env key
  // (VIDEOSTITCHER_ANTHROPIC_API_KEY). Refuse early with a 401 + actionable
  // message when neither is reachable — a deliberate refusal is 4xx, not 5xx
  // (CF strips CORS off 5xx; see CLAUDE.md REST conventions).
  if (!apiKey && !process.env.VIDEOSTITCHER_ANTHROPIC_API_KEY) {
    return fail(res, 401, "no Anthropic API key — set VIDEOSTITCHER_ANTHROPIC_API_KEY or pass apiKey");
  }

  // Best-effort load of the timeline so we can look up the clip + neighbors.
  // Absence is tolerated → text-only.
  let timeline = null;
  try { timeline = await loadTimeline(activeProjectDir); } catch { timeline = null; }

  // Resolve the clip + its narration text and time window.
  let clip = null;
  let text = body.text != null ? String(body.text) : undefined;
  let neighborContext;
  if (timeline && Array.isArray(timeline.narration)) {
    const byStart = [...timeline.narration].sort((a, b) => a.startSec - b.startSec);
    if (clipId) {
      const idx = byStart.findIndex((n) => n.id === clipId);
      if (idx >= 0) {
        clip = byStart[idx];
        if (text == null) text = clip.narration || "";
        const prev = idx > 0 ? byStart[idx - 1].narration : undefined;
        const next = idx < byStart.length - 1 ? byStart[idx + 1].narration : undefined;
        if ((prev && prev.trim()) || (next && next.trim())) {
          neighborContext = {
            ...(prev && prev.trim() ? { prev } : {}),
            ...(next && next.trim() ? { next } : {}),
          };
        }
      }
    }
  }

  // For 'improve' we need some text; for 'prompt' we need a prompt (or scene).
  if (mode === "improve" && !(text && text.trim())) {
    return fail(res, 400, "improve mode needs `text` or a `clipId` that resolves to a clip with narration");
  }

  // Best-effort analysis → sceneContext for the clip's time window. Absence is
  // tolerated; deriveSceneContext also returns undefined when nothing overlaps.
  let sceneContext;
  if (clip) {
    let analysis = null;
    try { analysis = await loadAnalysis(activeProjectDir); } catch { analysis = null; }
    if (analysis) {
      // Clip's PLAYED length on the timeline: a rendered clip honors its trim
      // window (audioInSec/audioOutSec), so the scene window only spans what
      // actually plays — using the full rendered duration would pull in scenes
      // from trimmed-out tail audio. Red clips use the words/pace estimate.
      let dur = 0;
      if (clip.audio && typeof clip.audio.durationSec === "number") {
        const inS = typeof clip.audioInSec === "number" ? clip.audioInSec : 0;
        const outS = typeof clip.audioOutSec === "number" ? clip.audioOutSec : clip.audio.durationSec;
        dur = Math.max(0, outS - inS);
      } else if (typeof clip.estDurationSec === "number") {
        dur = clip.estDurationSec;
      }
      // Map the narration's OUTPUT-timeline window to SOURCE-video seconds so the
      // analysis lookup is correct even after the video is trimmed/reordered/sped
      // (analysis segments are source-time). Three correctness guards:
      //  • analysis.json describes only the ORIGINAL source (sources[0]); in a
      //    multi-source project, narration over added footage must NOT be looked
      //    up in it → derive context only when the clip is over the analyzed
      //    source. Single-source is always analyzed; a gap falls back to raw
      //    output time (identity for an untrimmed take).
      //  • the scene window is CLAMPED within the start clip's shot, so a VO that
      //    spans a cut is grounded in its first shot, not a range jumping the cut.
      const sources = Array.isArray(timeline.sources) ? timeline.sources : [];
      const multiSource = sources.length > 1;
      const analyzedSourceId = sources[0] ? sources[0].id : undefined;
      const startClip = coveringVideoClip(timeline, clip.startSec);
      const overAnalyzed = !multiSource || (startClip ? startClip.v.sourceId === analyzedSourceId : false);
      if (overAnalyzed) {
        let startForLookup;
        let endForLookup;
        if (startClip) {
          startForLookup = srcSecIn(startClip, clip.startSec);
          if (dur > 0) {
            // Cap the end at the START shot's output-end so the source range stays
            // contiguous within one clip (no cross-cut spanning).
            const clipOutEnd = startClip.start + startClip.played;
            const endOut = Math.min(clip.startSec + dur, clipOutEnd);
            const srcEnd = srcSecIn(startClip, endOut);
            endForLookup = srcEnd > startForLookup ? srcEnd : undefined;
          }
        } else {
          // No covering clip (gap / past video) — single-source identity fallback.
          startForLookup = clip.startSec;
          endForLookup = dur > 0 ? clip.startSec + dur : undefined;
        }
        sceneContext = deriveSceneContext(analysis, startForLookup, endForLookup);
      }
    }
  }

  try {
    const result = await helpWriteNarration({
      mode,
      currentText: text,
      prompt: promptText,
      sceneContext,
      neighborContext,
      apiKey,
    });
    sendJson(res, 200, { ok: true, narration: result.narration, ...(result.note ? { note: result.note } : {}) });
  } catch (err) {
    // Distinguish operator-actionable refusals (no key / bad input) from a
    // genuine upstream Anthropic failure. The makeClient "no API key" path is
    // already guarded above, so a thrown "needs ..." validation is 400; the
    // rest are treated as upstream (502).
    const msg = String((err && err.message) || err);
    if (/no Anthropic API key/i.test(msg)) return fail(res, 401, err);
    if (/^(improve mode needs|prompt mode needs|unknown mode)/i.test(msg)) return fail(res, 400, err);
    return fail(res, 502, err);
  }
}

// GET /api/timeline — current timeline.json (auto-migrating from legacy
// script.json + voice.json the first time it's read on an existing project).
async function handleTimelineGet(req, res) {
  const { loadTimeline } = await lib();
  let timeline;
  try {
    timeline = await loadTimeline(activeProjectDir);
  } catch (err) {
    return fail(res, 404, err);
  }
  sendJson(res, 200, { ok: true, timeline });
}

// POST /api/timeline/save — body is a Timeline JSON; round-trips through
// TimelineSchema for validation before we trust it. The UI hits this on
// drag/edit (it's effectively the project's autosave endpoint).
async function handleTimelineSave(req, res) {
  const { saveTimeline, loadTimeline } = await lib();
  const incoming = await readJsonBody(req);
  await saveTimeline(activeProjectDir, incoming);
  const timeline = await loadTimeline(activeProjectDir);
  sendJson(res, 200, { ok: true, timeline });
}

// POST /api/timeline/render — { apiKey?, mock?, voiceId?, ids? }
// Renders narration audio (real or mock) into the selected clips and
// stamps the result onto narration[*].audio. With no `ids`, renders every
// red clip ("Render all unrendered" UI button); with `ids: [...]`, renders
// just those clips ("Render selected").
async function handleTimelineRender(req, res) {
  const { voiceCommand, mockVoiceCommand, loadTimeline } = await lib();
  const body = await readJsonBody(req);
  const apiKey = body.apiKey ? String(body.apiKey) : undefined;
  const envHasKey = !!process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY;
  // Resolution rules:
  //   - body.mock === true → operator EXPLICITLY opts into silent
  //     placeholders (offline / dev mode). Mock wins.
  //   - else: if a key is reachable (body OR env), use real voice.
  //     voiceCommand without opts.apiKey falls through to
  //     resolveApiKey which honors process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY.
  //   - else: nothing's reachable → silent mock with the operator
  //     getting a heads-up via the response body so the UI can warn.
  const forcedMock = body.mock === true;
  const haveKey = !!apiKey || envHasKey;
  const useMock = forcedMock || !haveKey;
  const ids = Array.isArray(body.ids) && body.ids.length > 0
    ? body.ids.map((v) => String(v))
    : undefined;
  const force = body.force === true;

  if (useMock) {
    await mockVoiceCommand(activeProjectDir, { ...(ids ? { ids } : {}) });
  } else {
    await voiceCommand(activeProjectDir, {
      // Pass apiKey through if present; otherwise voiceCommand /
      // resolveApiKey will pick up VIDEOSTITCHER_ELEVENLABS_API_KEY from env.
      ...(apiKey ? { apiKey } : {}),
      yes: true, // server context — no interactive confirm
      force,
      ...(body.voiceId ? { voice: String(body.voiceId) } : {}),
      ...(ids ? { ids } : {}),
    });
  }
  const timeline = await loadTimeline(activeProjectDir);
  // `mock` is preserved for backward-compat. `voiceProvider` is the
  // new explicit signal the UI uses to warn about silent renders.
  const voiceProvider = useMock ? (forcedMock ? "mock-forced" : "mock-no-key") : "elevenlabs";
  sendJson(res, 200, { ok: true, timeline, mock: useMock, voiceProvider });
}

// GET /api/voice/clip?id=seg-XX — stream the rendered audio clip for live preview.
// Range-aware so the browser can scrub. Path traversal is impossible because we
// only look up the segment by id and serve whatever audioPath the manifest
// references, but we still resolve the path and sanity-check it stays inside
// activeProjectDir.
const AUDIO_MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};
async function resolveAudioForNarration(id) {
  const { loadTimeline } = await lib();
  let timeline;
  try { timeline = await loadTimeline(activeProjectDir); }
  catch { return { err: "no timeline" }; }
  const n = timeline.narration.find((entry) => entry.id === id);
  if (!n) return { err: `no narration clip ${id}` };
  if (!n.audio) return { err: `narration ${id} has no rendered audio` };
  // audio.path is recorded relative to the project dir — resolve and pin
  // under activeProjectDir so a maliciously-edited timeline.json can't
  // exfiltrate /etc/passwd.
  const abs = path.resolve(activeProjectDir, n.audio.path);
  if (abs !== activeProjectDir && !abs.startsWith(activeProjectDir + path.sep)) {
    return { err: "clip path escapes project dir", status: 403 };
  }
  return { abs, durationSec: n.audio.durationSec };
}

async function handleVoiceClip(req, res, url) {
  const id = url.searchParams.get("id");
  if (!id) return fail(res, 400, "missing ?id");
  const r = await resolveAudioForNarration(id);
  if (r.err) return fail(res, r.status ?? 404, r.err);
  const abs = r.abs;
  let stat;
  try { stat = await fs.stat(abs); } catch { return fail(res, 404, "clip file missing"); }
  if (!stat.isFile()) return fail(res, 404, "clip path is not a file");

  const type = AUDIO_MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  const total = stat.size;
  const range = req.headers["range"];
  if (!range) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": total, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(abs);
    stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
    return stream.pipe(res);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
  // RFC 7233 §2.1 suffix-range support — same fix codex flagged on /api/output
  // in Round-6, applied here in Round-7 for parity. Audio decoders use suffix
  // ranges to probe trailing metadata.
  let start, end;
  if (m[1] === "" && m[2] === "") {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    return res.end();
  } else if (m[1] === "") {
    const suffix = parseInt(m[2], 10);
    if (Number.isNaN(suffix) || suffix <= 0) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    return res.end();
  }
  if (end >= total) end = total - 1;
  res.writeHead(206, {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(abs, { start, end });
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
  stream.pipe(res);
}

// GET /api/voice/clip/peaks?id=seg-XX&buckets=N — return absolute peak per
// bucket (C9). Used by the timeline editor to draw a tiny waveform inside
// each voice-clip block so the user can see audio shape against the video.
//
// Strategy: decode the clip to mono PCM s16le via ffmpeg, split the sample
// stream into N equal buckets, take max(abs(sample))/32768 per bucket. We
// downsample on decode (8 kHz is more than enough for waveform shape) so
// a 30 s clip fits in ~480 KB and the whole job is sub-second. Cached on
// disk at audio/seg-N.peaks.json — clips are immutable per voice run, so
// the first request pays the cost and every later request is a JSON read.
//
// Cache format: { schemaVersion: 1, sourceBytes: <stat.size>, sourceMtimeMs,
//                 sourceRate: 8000, peaks: number[400] }. We always compute
// at a fixed 400 source buckets and downsample server-side to whatever the
// caller asked for, so cache validity doesn't depend on bucket count.
const PEAKS_SCHEMA_VERSION = 1;
const PEAKS_SOURCE_BUCKETS = 400; // resolution of cached peaks
const PEAKS_DECODE_RATE = 8000;   // mono s16le sample rate fed to bucketing
const PEAKS_MAX_BUCKETS = 400;    // cap on ?buckets to keep responses tiny
const PEAKS_MIN_BUCKETS = 1;

function spawnPcmDecoder(srcPath) {
  // -nostdin so ffmpeg doesn't try to attach to our tty when run interactively.
  return spawn(
    FFMPEG_BIN,
    [
      "-nostdin",
      "-v", "error",
      "-i", srcPath,
      "-ac", "1",
      "-ar", String(PEAKS_DECODE_RATE),
      "-f", "s16le",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function decodePeaks(srcPath, buckets) {
  return new Promise((resolve, reject) => {
    const child = spawnPcmDecoder(srcPath);
    const chunks = [];
    let stderr = "";
    let totalBytes = 0;
    child.stdout.on("data", (c) => { chunks.push(c); totalBytes += c.length; });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg decode exited ${code}: ${stderr.trim().split("\n").slice(-4).join("\n")}`));
      }
      // Stitch the chunks and run the bucketing pass on an Int16Array view.
      const buf = Buffer.concat(chunks, totalBytes);
      // Drop an odd trailing byte just in case (s16le is 2 bytes / sample).
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      const n = samples.length;
      if (n === 0 || buckets < 1) return resolve(new Array(Math.max(0, buckets)).fill(0));
      const peaks = new Array(buckets).fill(0);
      // Walk samples once; assign each to its bucket by floor(i * buckets / n).
      // This is more accurate than n/buckets stride when n is small relative
      // to buckets (some buckets get 1 sample, others 2 — still correct).
      for (let i = 0; i < n; i++) {
        const b = (i * buckets / n) | 0;
        const s = samples[i];
        const abs = s < 0 ? -s : s;
        if (abs > peaks[b]) peaks[b] = abs;
      }
      // Normalize to 0..1 against int16 max (32768).
      for (let i = 0; i < buckets; i++) peaks[i] = peaks[i] / 32768;
      resolve(peaks);
    });
  });
}

function downsamplePeaks(src, target) {
  if (target >= src.length) return src.slice();
  const out = new Array(target).fill(0);
  for (let i = 0; i < src.length; i++) {
    const b = (i * target / src.length) | 0;
    if (src[i] > out[b]) out[b] = src[i];
  }
  return out;
}

let FFMPEG_BIN = null;
let FFPROBE_BIN = null;
async function resolveFfmpegBin() {
  if (FFMPEG_BIN) return FFMPEG_BIN;
  const { FFMPEG_PATH } = await lib();
  FFMPEG_BIN = FFMPEG_PATH || "ffmpeg";
  return FFMPEG_BIN;
}
async function resolveFfprobeBin() {
  if (FFPROBE_BIN) return FFPROBE_BIN;
  const { FFPROBE_PATH } = await lib();
  FFPROBE_BIN = FFPROBE_PATH || "ffprobe";
  return FFPROBE_BIN;
}

// In-flight dedup so concurrent peak requests for the same clip share one
// ffmpeg decode pass instead of spawning duplicate processes.
const peaksInflight = new Map();

async function loadOrComputePeaks(srcPath, cachePath) {
  let stat;
  try { stat = await fs.stat(srcPath); }
  catch { throw Object.assign(new Error("clip file missing"), { code: "not-found" }); }
  if (!stat.isFile()) throw Object.assign(new Error("clip path is not a file"), { code: "not-found" });

  // Try cache first.
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cached = JSON.parse(raw);
    if (
      cached &&
      cached.schemaVersion === PEAKS_SCHEMA_VERSION &&
      cached.sourceBytes === stat.size &&
      cached.sourceMtimeMs === stat.mtimeMs &&
      Array.isArray(cached.peaks) &&
      cached.peaks.length === PEAKS_SOURCE_BUCKETS
    ) {
      return cached.peaks;
    }
  } catch {
    /* cache miss or corrupt — recompute */
  }

  // Dedup in-flight decodes by cache path.
  if (peaksInflight.has(cachePath)) return peaksInflight.get(cachePath);
  const p = (async () => {
    await resolveFfmpegBin();
    const peaks = await decodePeaks(srcPath, PEAKS_SOURCE_BUCKETS);
    const body = {
      schemaVersion: PEAKS_SCHEMA_VERSION,
      sourceBytes: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceRate: PEAKS_DECODE_RATE,
      peaks,
    };
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(body));
    } catch (e) {
      process.stderr.write(`[peaks] cache write failed for ${cachePath}: ${e}\n`);
    }
    return peaks;
  })();
  peaksInflight.set(cachePath, p);
  try { return await p; }
  finally { peaksInflight.delete(cachePath); }
}

async function handleVoiceClipPeaks(req, res, url) {
  const id = url.searchParams.get("id");
  if (!id) return fail(res, 400, "missing ?id");
  let buckets = parseInt(url.searchParams.get("buckets") || "120", 10);
  if (!Number.isFinite(buckets)) buckets = 120;
  buckets = Math.max(PEAKS_MIN_BUCKETS, Math.min(PEAKS_MAX_BUCKETS, buckets));

  const r = await resolveAudioForNarration(id);
  if (r.err) return fail(res, r.status ?? 404, r.err);
  const abs = r.abs;
  const durationSec = r.durationSec;
  // Cache file sits next to the audio file: e.g. audio/seg-001.mp3 →
  // audio/seg-001.peaks.json. The .json extension keeps it human-readable
  // and `MIME` already covers it for any accidental static-style fetch.
  const ext = path.extname(abs);
  const cachePath = (ext ? abs.slice(0, -ext.length) : abs) + ".peaks.json";

  let peaks;
  try {
    peaks = await loadOrComputePeaks(abs, cachePath);
  } catch (err) {
    if (err && err.code === "not-found") return fail(res, 404, err);
    process.stderr.write(`[peaks] decode failed for ${id}: ${err && err.stack ? err.stack : err}\n`);
    return fail(res, 500, err);
  }

  const out = downsamplePeaks(peaks, buckets);
  // Round to 3 decimals to halve the JSON size with no visible quality loss.
  const rounded = out.map((v) => Math.round(v * 1000) / 1000);
  sendJson(res, 200, {
    ok: true,
    id,
    buckets: rounded.length,
    durationSec,
    peaks: rounded,
  });
}

// (POST /api/voice and POST /api/voice/save retired in Phase 1.2 — the
// unified surface is /api/timeline/save + /api/timeline/render.)

// GET /api/video/thumbnails?count=N (or &interval=Ns) — sprite-sheet of N
// evenly-spaced frames from the source video. The strip above the timeline
// (C10) uses this to anchor segment / clip drags against the actual frame
// content. Returns JSON metadata; the sprite bytes are fetched separately
// from /api/video/thumbnails/sprite?count=N so the same handler doesn't have
// to multiplex JSON and image/jpeg.
//
// Caching: <activeProjectDir>/thumbs/sprite-<count>.jpg + a sibling .meta.json
// that records the source mtime/size + sprite layout. Each project has its
// own thumb cache (lives under the project dir); a changed mtime/size on
// the source invalidates an in-place cache file.
//
// Concurrency: in-flight requests for the same count share one ffmpeg run.
const THUMB_DIR_NAME = "thumbs";
const THUMB_SCHEMA_VERSION = 1;
const THUMB_FRAME_WIDTH = 160;
const THUMB_FRAME_HEIGHT = 90;
const THUMB_MIN_COUNT = 4;
const THUMB_MAX_COUNT = 240;
const THUMB_DEFAULT_COUNT = 60;
const thumbsInflight = new Map(); // count → Promise<{spritePath, meta}>

async function probeVideoDuration(videoPath) {
  await resolveFfprobeBin();
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err.trim()}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n) || n <= 0) return reject(new Error("ffprobe returned no usable duration"));
      resolve(n);
    });
  });
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stdout.on("data", () => { /* discard */ });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = err.trim().split("\n").slice(-8).join("\n");
        return reject(new Error(`ffmpeg exited ${code}: ${tail}`));
      }
      resolve();
    });
  });
}

async function resolveSourceVideo() {
  const { loadProject } = await lib();
  let project;
  try { project = await loadProject(activeProjectDir); }
  catch { throw Object.assign(new Error("no project — upload a video first"), { code: "not-found" }); }
  if (!project || !project.videoPath) {
    throw Object.assign(new Error("project has no video path"), { code: "not-found" });
  }
  const abs = path.resolve(String(project.videoPath));
  let stat;
  try { stat = await fs.stat(abs); }
  catch { throw Object.assign(new Error("source video missing on disk"), { code: "not-found" }); }
  if (!stat.isFile()) throw Object.assign(new Error("video path is not a file"), { code: "not-found" });
  return { videoPath: abs, stat };
}

function thumbPaths(count) {
  const dir = path.join(activeProjectDir, THUMB_DIR_NAME);
  const spritePath = path.join(dir, `sprite-${count}.jpg`);
  const metaPath = spritePath + ".meta.json";
  return { dir, spritePath, metaPath };
}

async function readCachedSprite(count, sourceStat) {
  const { spritePath, metaPath } = thumbPaths(count);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    if (
      meta &&
      meta.schemaVersion === THUMB_SCHEMA_VERSION &&
      meta.sourceBytes === sourceStat.size &&
      meta.sourceMtimeMs === sourceStat.mtimeMs &&
      meta.count === count
    ) {
      // Confirm the sprite file itself still exists.
      await fs.stat(spritePath);
      return { spritePath, meta };
    }
  } catch {
    /* miss — recompute */
  }
  return null;
}

async function buildSprite(count, videoPath, sourceStat) {
  const { dir, spritePath, metaPath } = thumbPaths(count);
  await fs.mkdir(dir, { recursive: true });
  await resolveFfmpegBin();
  const durationSec = await probeVideoDuration(videoPath);
  const fps = (count / durationSec).toFixed(12); // exact-ish rational; ffmpeg parses floats
  // fps → tile pipeline:
  //   • `fps=count/duration`  → ~count input frames spaced evenly through the clip
  //   • `scale + pad`         → letterbox each frame to a uniform W×H box
  //   • `tile=countx1`        → pack count input frames horizontally into one image
  //   • `-frames:v 1`         → stop after the first tiled output frame
  //
  // If fps rounding yields slightly fewer than `count` frames, tile pads the
  // remainder with black; slightly more, the extras are dropped. The strip
  // width is always count × frameWidth, so client-side positioning stays
  // exact regardless of those edge cells.
  const filter =
    `fps=${fps},` +
    `scale=${THUMB_FRAME_WIDTH}:${THUMB_FRAME_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${THUMB_FRAME_WIDTH}:${THUMB_FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `tile=${count}x1`;
  // ffmpeg infers the output muxer from the file extension, so keep `.jpg`
  // at the tail of the temp name — `.tmp.<pid>` alone trips
  // "Unable to choose an output format" (smoke-tested 2026-05-24).
  const tmpPath = spritePath.replace(/\.jpg$/, `.tmp.${process.pid}.jpg`);
  try {
    await ffmpegRun([
      "-nostdin", "-v", "error", "-y",
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", filter,
      "-q:v", "4",
      tmpPath,
    ]);
    await fs.rename(tmpPath, spritePath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* */ }
    throw err;
  }
  const meta = {
    schemaVersion: THUMB_SCHEMA_VERSION,
    sourceBytes: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    count,
    frameWidth: THUMB_FRAME_WIDTH,
    frameHeight: THUMB_FRAME_HEIGHT,
    durationSec,
    intervalSec: durationSec / count,
    builtAt: Date.now(),
  };
  try { await fs.writeFile(metaPath, JSON.stringify(meta)); }
  catch (e) { process.stderr.write(`[thumbs] meta write failed for count=${count}: ${e}\n`); }
  return { spritePath, meta };
}

async function ensureSprite(count, videoPath, sourceStat) {
  const cached = await readCachedSprite(count, sourceStat);
  if (cached) return cached;
  if (thumbsInflight.has(count)) return thumbsInflight.get(count);
  const p = buildSprite(count, videoPath, sourceStat);
  thumbsInflight.set(count, p);
  try { return await p; }
  finally { thumbsInflight.delete(count); }
}

function parseThumbCount(url, durationHint) {
  const intervalRaw = url.searchParams.get("interval");
  const countRaw = url.searchParams.get("count");
  let count;
  if (intervalRaw != null && intervalRaw !== "") {
    const interval = parseFloat(intervalRaw);
    if (!Number.isFinite(interval) || interval <= 0) return { error: "invalid ?interval" };
    if (!durationHint || !Number.isFinite(durationHint) || durationHint <= 0) {
      // Fall back to default; caller can re-issue with a count once it knows duration.
      count = THUMB_DEFAULT_COUNT;
    } else {
      count = Math.ceil(durationHint / interval);
    }
  } else if (countRaw != null && countRaw !== "") {
    count = parseInt(countRaw, 10);
    if (!Number.isFinite(count)) return { error: "invalid ?count" };
  } else {
    count = THUMB_DEFAULT_COUNT;
  }
  count = Math.max(THUMB_MIN_COUNT, Math.min(THUMB_MAX_COUNT, count | 0));
  return { count };
}

// GET /api/video/thumbnails?count=N — JSON metadata + spriteUrl pointer.
async function handleThumbnailsMeta(req, res, url) {
  let videoPath, stat;
  try { ({ videoPath, stat } = await resolveSourceVideo()); }
  catch (err) { return fail(res, err.code === "not-found" ? 404 : 500, err); }

  // We don't know duration without probing or reading analysis, so &interval
  // gets a probe-then-resolve. ?count is cheaper (no probe needed up-front).
  let count;
  if (url.searchParams.get("interval")) {
    try {
      const dur = await probeVideoDuration(videoPath);
      const r = parseThumbCount(url, dur);
      if (r.error) return fail(res, 400, r.error);
      count = r.count;
    } catch (err) { return fail(res, 500, err); }
  } else {
    const r = parseThumbCount(url);
    if (r.error) return fail(res, 400, r.error);
    count = r.count;
  }

  let built;
  try { built = await ensureSprite(count, videoPath, stat); }
  catch (err) {
    process.stderr.write(`[thumbs] build failed for count=${count}: ${err && err.stack ? err.stack : err}\n`);
    return fail(res, 500, err);
  }
  const { meta } = built;
  // Cache-bust the sprite URL with the source mtime so a re-upload's freshly-
  // computed sprite invalidates any browser-cached image at the same URL.
  const v = Math.floor(stat.mtimeMs);
  sendJson(res, 200, {
    ok: true,
    count: meta.count,
    frameWidth: meta.frameWidth,
    frameHeight: meta.frameHeight,
    durationSec: meta.durationSec,
    intervalSec: meta.intervalSec,
    spriteUrl: `/api/video/thumbnails/sprite?count=${meta.count}&v=${v}`,
  });
}

// GET /api/video/thumbnails/sprite?count=N — image/jpeg bytes from cache.
async function handleThumbnailsSprite(req, res, url) {
  let videoPath, stat;
  try { ({ videoPath, stat } = await resolveSourceVideo()); }
  catch (err) { return fail(res, err.code === "not-found" ? 404 : 500, err); }
  const r = parseThumbCount(url);
  if (r.error) return fail(res, 400, r.error);
  let built;
  try { built = await ensureSprite(r.count, videoPath, stat); }
  catch (err) { return fail(res, 500, err); }
  const { spritePath, meta } = built;
  let spriteStat;
  try { spriteStat = await fs.stat(spritePath); } catch { return fail(res, 500, "sprite vanished after build"); }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": spriteStat.size,
    "Cache-Control": "private, max-age=86400",
    "X-Thumb-Count": String(meta.count),
    "X-Thumb-Frame-Width": String(meta.frameWidth),
    "X-Thumb-Frame-Height": String(meta.frameHeight),
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(spritePath);
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
  stream.pipe(res);
}

// (POST /api/voice retired in Phase 1.2 — superseded by /api/timeline/render.)

// POST /api/run — orchestrate analyze → script → voice as one streamed pipeline.
// Body: { geminiKey?, claudeKey?, elevenKey?, fps?, voiceId?, mock? }.
// Streams Server-Sent Events:
//   event: pipeline → { stages: [...], runId }
//   event: stage    → { stage, status: 'started' | 'completed' | 'failed', detail?, error? }
//   event: done     → { ok: true, project, hasAnalysis, hasTimeline, hasOutput, renderedCount, totalCount }
//   event: error    → { ok: false, error }
// Stitch is intentionally NOT chained — that's an explicit user gesture once
// they're happy with the timeline (V3 will surface the button).
async function handleRun(req, res) {
  // P2 (codex Round-4): claim the slot BEFORE the first await so two
  // concurrent POSTs can't both pass the check while readJsonBody's microtask
  // is pending. Release the flag on any pre-pipeline failure (body parse,
  // openSse) so a 400 doesn't leave the server permanently 409-ing.
  if (runInFlight) {
    return fail(res, 409, "another run is already in progress for this project");
  }
  runInFlight = true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    runInFlight = false;
    return fail(res, 400, e);
  }
  const geminiKey = body.geminiKey ? String(body.geminiKey) : undefined;
  const claudeKey = body.claudeKey ? String(body.claudeKey) : undefined;
  const elevenKey = body.elevenKey ? String(body.elevenKey) : undefined;
  const elevenEnv = !!process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY;
  const voiceId   = body.voiceId   ? String(body.voiceId)   : undefined;
  const fps       = body.fps != null ? Number(body.fps)     : undefined;
  // Voice mode mirrors handleVoice's resolution: explicit mock wins, otherwise
  // real iff an ElevenLabs key was supplied.
  // Same resolution rules as /api/timeline/render: only force mock when
  // the operator explicitly opts in OR when no key is reachable from
  // body / env. Prevents the "blank form field → silent voice even
  // though env has the key" pitfall the UI hit pre-fix.
  const useMock   = body.mock === true || (!elevenKey && !elevenEnv);

  // P2 deferred to after voice succeeds — see the unlink-on-success block
  // below. Doing it pre-run leaks a stale-state window on failed reruns: the
  // client only updates hasOutput from the `done` event, so a failed rerun
  // would have unlinked the file but left the UI advertising it as present.
  // (codex Round-3 follow-up to Round-2.)
  const sse = openSse(req, res);
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stages = ["analyze", "script", "voice"];
  sse.send("pipeline", { runId, stages, voiceMode: useMock ? "mock" : "real" });

  // Detach client-side aborts from the in-flight pipeline. We can't actually
  // interrupt a running ffmpeg/Gemini/Claude/ElevenLabs call mid-flight from
  // here without spawning child processes we own — but we should at least stop
  // emitting events to a closed socket and free the in-flight flag once the
  // chain settles. The stages run to completion server-side; that's fine —
  // they're idempotent on the project dir.
  let clientClosed = false;
  req.on("close", () => { clientClosed = true; });

  async function runStage(name, fn) {
    sse.send("stage", { stage: name, status: "started" });
    try {
      const detail = await fn();
      sse.send("stage", { stage: name, status: "completed", detail: detail ?? null });
      return { ok: true, detail };
    } catch (err) {
      const msg = richMessage(err);
      sse.send("stage", { stage: name, status: "failed", error: msg });
      return { ok: false, error: msg };
    }
  }

  try {
    const {
      analyzeCommand,
      scriptCommand,
      buildTimelineFromAnalysis,
      loadAnalysis,
      loadProject,
      loadTimeline,
      saveTimeline,
      voiceCommand,
      mockVoiceCommand,
      FILES,
      projectPath,
    } = await lib();

    // ── analyze ─────────────────────────────────────────────────────────────
    const a = await runStage("analyze", async () => {
      const opts = {};
      if (geminiKey) opts.apiKey = geminiKey;
      if (fps != null && Number.isFinite(fps)) opts.fps = fps;
      const analysis = await analyzeCommand(activeProjectDir, opts);
      return { segments: analysis?.segments?.length ?? 0, usedKey: Boolean(geminiKey) };
    });
    if (!a.ok) { sse.send("error", { ok: false, error: `analyze failed: ${a.error}` }); sse.end(); return; }

    // ── script: writes timeline.json (Claude draft if key, else fallback) ──
    const s = await runStage("script", async () => {
      let usedFallback = false;
      try {
        // claudeKey may be undefined — scriptCommand resolves the env key
        // (VIDEOSTITCHER_ANTHROPIC_API_KEY) so a workspace key is used without
        // the browser re-sending it (the UI hides the field when env key is
        // present). Throws if no key resolvable OR Claude fails → fallback.
        await scriptCommand(activeProjectDir, { apiKey: claudeKey, force: true });
      } catch (err) {
        process.stderr.write(`[run] Claude stage unavailable, using analysis-derived draft: ${err}\n`);
        usedFallback = true;
      }
      if (usedFallback) {
        const [project, analysis] = await Promise.all([
          loadProject(activeProjectDir),
          loadAnalysis(activeProjectDir),
        ]);
        const draft = {
          segments: analysis.segments.map((seg) => ({
            id: seg.id,
            narration: (seg.suggestedBeat || seg.visualSummary || "").trim(),
            pauseAfterSec: 0,
          })),
        };
        const { timeline } = buildTimelineFromAnalysis(project, analysis, draft);
        await saveTimeline(activeProjectDir, timeline);
      }
      const timeline = await loadTimeline(activeProjectDir);
      return { narration: timeline?.narration?.length ?? 0, usedFallback };
    });
    if (!s.ok) { sse.send("error", { ok: false, error: `script failed: ${s.error}` }); sse.end(); return; }

    // Clear stale final.mp4 BEFORE render runs (script stage always uses
    // force:true so any prior render is stale relative to the new narration).
    // The render stage rewrites narration[].audio in place so audio files on
    // disk that still match their narrationHash get reused; nothing to unlink
    // there. (Drift detection lives in voiceCommand's hashMatches check.)
    const outputPath = projectPath(activeProjectDir, FILES.output);
    try { await fs.unlink(outputPath); } catch (e) {
      if (e?.code !== "ENOENT") process.stderr.write(`[run] failed to unlink stale ${outputPath}: ${e}\n`);
    }

    // ── voice (real if a key is reachable from body or env; else mock) ─────
    const v = await runStage("voice", async () => {
      if (useMock) {
        const t = await mockVoiceCommand(activeProjectDir, {});
        return { mode: "mock", rendered: t.narration.filter((n) => n.audio).length };
      }
      // force:true so a rerun with edited narration regenerates rather than
      // reusing stale audio. (voiceCommand also checks narrationHash, so
      // unchanged clips are still skipped when force:false — but `run` does
      // a full regen by design.) When elevenKey is undefined here it's
      // because the env-only path is active; voiceCommand's resolveApiKey
      // will pick up process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY.
      const t = await voiceCommand(activeProjectDir, {
        ...(elevenKey ? { apiKey: elevenKey } : {}),
        yes: true,
        force: true,
        ...(voiceId ? { voice: voiceId } : {}),
      });
      return { mode: "real", rendered: t.narration.filter((n) => n.audio).length };
    });
    if (!v.ok) { sse.send("error", { ok: false, error: `voice failed: ${v.error}` }); sse.end(); return; }

    // Closing summary mirrors /api/state so the UI can refresh without a
    // follow-up GET. timeline.json is freshly written; final.mp4 stays
    // absent (user re-renders explicitly via /api/stitch).
    let project;
    try { project = await loadProject(activeProjectDir); } catch { project = undefined; }
    const finalTimeline = await loadTimeline(activeProjectDir).catch(() => null);
    const renderedCount = finalTimeline ? finalTimeline.narration.filter((n) => n.audio).length : 0;
    const totalCount = finalTimeline ? finalTimeline.narration.length : 0;
    const [hasAnalysis, hasTimeline, hasOutput] = await Promise.all([
      exists(projectPath(activeProjectDir, FILES.analysis)),
      exists(projectPath(activeProjectDir, FILES.timeline)),
      exists(outputPath),
    ]);
    sse.send("done", {
      ok: true,
      project,
      hasAnalysis,
      hasTimeline,
      hasOutput,
      renderedCount,
      totalCount,
    });
  } catch (err) {
    process.stderr.write(`[run] pipeline crashed: ${err && err.stack ? err.stack : err}\n`);
    sse.send("error", { ok: false, error: err && err.message ? err.message : String(err) });
  } finally {
    runInFlight = false;
    sse.end();
    if (clientClosed) {
      // No-op — the stream is already closed. Logged at debug for parity.
    }
  }
}

// POST /api/stitch — ffmpeg → out/final.mp4.
//
// Streamed as SSE (not a blocking JSON response): a real encode runs for
// many seconds-to-minutes, and a blocking response 504'd at the proxy once
// the filter graph was valid enough for ffmpeg to actually encode (earlier
// failures returned fast). openSse's 15s heartbeat keeps the connection
// alive; ffmpeg's `time=` lines are forwarded as progress. Terminal frame
// is `done` (ok) or `error`.
async function handleStitch(req, res) {
  const { stitchCommand, FILES, projectPath } = await lib();
  const sse = openSse(req, res);
  try {
    await stitchCommand(activeProjectDir, {
      onProgress: (line) => {
        if (typeof line === "string" && line.includes("time=")) {
          sse.send("progress", { line });
        }
      },
    });
    sse.send("done", { ok: true, outPath: projectPath(activeProjectDir, FILES.output) });
  } catch (err) {
    sse.send("error", { ok: false, error: richMessage(err) });
  } finally {
    sse.end();
  }
}

// GET /api/output — stream the rendered final mp4 INLINE for in-page playback.
// /api/download exists for the download button (Content-Disposition: attachment,
// no Range support) but the inline final-video player needs range-aware bytes
// so seeks work, especially on Safari/iOS where the media element won't play
// MP4 without 206 responses. (codex Round-5 P2.)
async function handleOutputInline(req, res) {
  const { FILES, projectPath } = await lib();
  // Prefer the light 720p proxy for smooth in-page streaming + seeking; fall
  // back to the full-res output when the proxy is absent (older project, or
  // the best-effort preview pass failed). /api/download always serves the
  // full-res final.mp4.
  const previewPath = projectPath(activeProjectDir, FILES.outputPreview);
  const fullPath = projectPath(activeProjectDir, FILES.output);
  const outPath = (await exists(previewPath)) ? previewPath : fullPath;
  if (!(await exists(outPath))) return fail(res, 404, "no output yet — run stitch first");
  const stat = await fs.stat(outPath);
  const total = stat.size;
  const range = req.headers["range"];
  const type = "video/mp4";

  if (!range) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": total, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(outPath);
    stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
    return stream.pipe(res);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
  // RFC 7233 §2.1 — `bytes=-N` is a SUFFIX range meaning the last N bytes,
  // NOT a 0-N range. Empty start + non-empty end ⇒ last `end` bytes (codex
  // Round-6 P2). Empty end + non-empty start ⇒ start through EOF. Both
  // empty is invalid.
  let start, end;
  if (m[1] === "" && m[2] === "") {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    return res.end();
  } else if (m[1] === "") {
    const suffix = parseInt(m[2], 10);
    if (Number.isNaN(suffix) || suffix <= 0) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    return res.end();
  }
  if (end >= total) end = total - 1;
  res.writeHead(206, {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(outPath, { start, end });
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
  stream.pipe(res);
}

// GET /api/download — stream the final mp4.
async function handleDownload(req, res) {
  const { FILES, projectPath } = await lib();
  const outPath = projectPath(activeProjectDir, FILES.output);
  if (!(await exists(outPath))) return fail(res, 404, "no output yet — run stitch first");
  const stat = await fs.stat(outPath);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": stat.size,
    "Content-Disposition": 'attachment; filename="final.mp4"',
  });
  const stream = createReadStream(outPath);
  stream.on("error", () => {
    if (!res.headersSent) fail(res, 500, "read error");
    else res.destroy();
  });
  stream.pipe(res);
}

// GET /api/video — stream the SOURCE uploaded video (HTTP Range aware) so the
// timeline editor can play + seek. Path comes from project.json's videoPath.
const VIDEO_MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
};
async function handleVideo(req, res) {
  let videoPath;
  try {
    const { loadProject } = await lib();
    const project = await loadProject(activeProjectDir);
    videoPath = project && project.videoPath ? path.resolve(String(project.videoPath)) : null;
  } catch {
    return fail(res, 404, "no project — upload a video first");
  }
  if (!videoPath) return fail(res, 404, "project has no video path");
  return streamVideoFile(req, res, videoPath);
}

// GET /api/source?id=<sourceId> — stream an ADDITIONAL timeline source
// (multi-clip projects) for the live-preview compositor, same Range support as
// /api/video. The primary source is still served by /api/video. Path comes from
// timeline.sources[id].filePath, resolved against the active project dir.
async function handleSource(req, res, query) {
  const id = query && query.get ? query.get("id") : null;
  if (!id) return fail(res, 400, "missing ?id=");
  let filePath;
  try {
    const { loadTimeline } = await lib();
    const timeline = await loadTimeline(activeProjectDir);
    const src = (timeline.sources || []).find((s) => s.id === id);
    if (!src) return fail(res, 404, `unknown source ${id}`);
    filePath = path.resolve(activeProjectDir, src.filePath);
    // SECURITY: source paths come from a client-saved timeline — never stream a
    // path that escapes the project dir (e.g. an absolute "/etc/passwd" or a
    // "../.." traversal saved into timeline.sources). The upload/import flows
    // only ever write inside the project, so containment is the correct gate.
    const root = path.resolve(activeProjectDir);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return fail(res, 403, "source path outside project");
    }
  } catch {
    return fail(res, 404, "no project / timeline");
  }
  return streamVideoFile(req, res, filePath);
}

// Shared HTTP-Range file streamer (used by /api/video + /api/source).
async function streamVideoFile(req, res, videoPath) {
  let stat;
  try {
    stat = await fs.stat(videoPath);
    if (!stat.isFile()) return fail(res, 404, "video path is not a file");
  } catch {
    return fail(res, 404, "source video missing on disk");
  }

  const type = VIDEO_MIME[path.extname(videoPath).toLowerCase()] || "application/octet-stream";
  const total = stat.size;
  const range = req.headers["range"];

  // No Range header → full 200 stream.
  if (!range) {
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
    });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(videoPath);
    stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
    return stream.pipe(res);
  }

  // Parse "bytes=start-end" per RFC 7233: either bound may be absent, and a
  // missing first bound ("bytes=-N") is a SUFFIX range = the last N bytes
  // (media tools use it to probe MP4 trailers). "bytes=-" is invalid.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  const invalid416 = () => { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); };
  if (!m || (m[1] === "" && m[2] === "")) return invalid416();
  let start, end;
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = parseInt(m[2], 10);
    if (Number.isNaN(n) || n <= 0) return invalid416();
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) return invalid416();
  if (end >= total) end = total - 1;

  res.writeHead(206, {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(videoPath, { start, end });
  stream.on("error", () => { if (!res.headersSent) fail(res, 500, "read error"); else res.destroy(); });
  stream.pipe(res);
}

// GET /api/keys — presence of provider keys in the workspace env. Returns
// "env" if the corresponding env var is set, "missing" otherwise. The UI uses
// this to auto-hide the BYOK input when a workspace key was injected via the
// tileapp secret-grant path (Cards E + F). NEVER returns the value itself —
// only the presence flag — so the response is safe to ship to the client.
function handleKeys(req, res) {
  const present = (v) => (typeof v === "string" && v.length > 0 ? "env" : "missing");
  sendJson(res, 200, {
    ok: true,
    gemini: present(process.env.VIDEOSTITCHER_GEMINI_API_KEY),
    anthropic: present(process.env.VIDEOSTITCHER_ANTHROPIC_API_KEY),
    eleven: present(process.env.VIDEOSTITCHER_ELEVENLABS_API_KEY),
  });
}

// GET /api/state — which artifacts exist + render progress on the timeline.
async function handleState(req, res) {
  // No active project (fresh boot, no uploads yet, or operator just
  // deleted the last one) — return an empty state instead of 5xx'ing.
  // The UI uses this exact shape's `project == null` to render its
  // upload-prompt empty state.
  if (!activeProjectDir) {
    return sendJson(res, 200, {
      ok: true,
      project: undefined,
      hasAnalysis: false,
      hasTimeline: false,
      hasOutput: false,
      renderedCount: 0,
      totalCount: 0,
      activeProjectId: null,
    });
  }
  const { FILES, projectPath, loadProject, loadTimeline } = await lib();
  let project;
  try { project = await loadProject(activeProjectDir); } catch { project = undefined; }

  const [hasAnalysis, hasTimeline, hasOutput] = await Promise.all([
    exists(projectPath(activeProjectDir, FILES.analysis)),
    exists(projectPath(activeProjectDir, FILES.timeline)),
    exists(projectPath(activeProjectDir, FILES.output)),
  ]);

  // Cheap render-progress count if a timeline exists — avoids the UI
  // needing a second /api/timeline call just to badge the "render all
  // unrendered (N)" button.
  let renderedCount = 0;
  let totalCount = 0;
  if (hasTimeline) {
    try {
      const t = await loadTimeline(activeProjectDir);
      totalCount = t.narration.length;
      renderedCount = t.narration.filter((n) => n.audio).length;
    } catch { /* shape mismatch — let UI surface it via /api/timeline */ }
  }
  sendJson(res, 200, {
    ok: true,
    project,
    hasAnalysis,
    hasTimeline,
    hasOutput,
    renderedCount,
    totalCount,
    activeProjectId,
  });
}

// ── dispatch ──────────────────────────────────────────────────────────────

/** Per-project endpoints that read or mutate `activeProjectDir`. A 409
 *  with a clean reason is friendlier than letting these path.join(null)
 *  and 500 (CLAUDE.md: 4xx for client-actionable, 5xx for genuine
 *  server failures — and CF strips CORS off 5xx). */
const ACTIVE_PROJECT_REQUIRED_PATHS = new Set([
  "POST /api/analyze",
  "POST /api/script",
  "POST /api/narration/help",
  "GET /api/timeline",
  "POST /api/timeline/save",
  "POST /api/timeline/render",
  "POST /api/sources",
  // audio bytes (kept post-Phase-1.4 too — bytes are bytes)
  "GET /api/voice/clip",
  "HEAD /api/voice/clip",
  "GET /api/voice/clip/peaks",
  "POST /api/run",
  "POST /api/stitch",
  "GET /api/video",
  "HEAD /api/video",
  "GET /api/video/thumbnails",
  "GET /api/video/thumbnails/sprite",
  "HEAD /api/video/thumbnails/sprite",
  "GET /api/output",
  "HEAD /api/output",
  "GET /api/download",
]);
async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const { pathname } = url;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method not allowed");
    return serveStatic(req, res, pathname);
  }

  const key = `${method} ${pathname}`;

  // Per-project endpoints fail-fast with a 409 + structured reason
  // when there's no active project, instead of letting downstream
  // code path.join(null) and 500.
  if (ACTIVE_PROJECT_REQUIRED_PATHS.has(key) && !activeProjectDir) {
    return fail(res, 409, "no active project — upload a video or select an existing one");
  }

  // Library endpoints — /api/projects, /api/projects/:id/select, /api/projects/:id.
  // Switch-statement keys must be string literals, so the parameterized
  // shapes get a small prefix-match path below.
  if (pathname === "/api/projects") {
    if (method === "GET") return handleListProjects(req, res);
    return fail(res, 405, "method not allowed");
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(select|poster|rename))?$/);
  if (projectMatch) {
    const pid = decodeURIComponent(projectMatch[1]);
    if (!isValidProjectId(pid)) return fail(res, 400, "invalid project id");
    const action = projectMatch[2];
    if (action === "select") {
      if (method !== "POST") return fail(res, 405, "method not allowed");
      return handleSelectProject(req, res, pid);
    }
    if (action === "poster") {
      if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method not allowed");
      return handleProjectPoster(req, res, pid);
    }
    if (action === "rename") {
      if (method !== "POST") return fail(res, 405, "method not allowed");
      return handleRenameProject(req, res, pid);
    }
    if (method === "DELETE") return handleDeleteProject(req, res, pid);
    return fail(res, 405, "method not allowed");
  }

  switch (key) {
    case "POST /api/upload":
      return handleUpload(req, res, url);
    case "GET /api/workspace-videos":
      return handleWorkspaceVideos(req, res);
    case "POST /api/import-from-workspace":
      return handleImportFromWorkspace(req, res);
    case "POST /api/upload-sidecar":
      return handleUploadSidecar(req, res, url);
    case "POST /api/sources":
      return handleAddSource(req, res, url);
    case "POST /api/audio":
      return handleUploadAudio(req, res, url);
    case "POST /api/analyze":
      return handleAnalyze(req, res);
    case "POST /api/script":
      return handleScriptDraft(req, res);
    case "POST /api/narration/help":
      return handleNarrationHelp(req, res);
    case "GET /api/timeline":
      return handleTimelineGet(req, res);
    case "POST /api/timeline/save":
      return handleTimelineSave(req, res);
    case "POST /api/timeline/render":
      return handleTimelineRender(req, res);
    case "GET /api/voice/clip":
    case "HEAD /api/voice/clip":
      return handleVoiceClip(req, res, url);
    case "GET /api/voice/clip/peaks":
      return handleVoiceClipPeaks(req, res, url);
    case "POST /api/run":
      return handleRun(req, res);
    case "POST /api/stitch":
      return handleStitch(req, res);
    case "GET /api/video":
    case "HEAD /api/video":
      return handleVideo(req, res);
    case "GET /api/source":
    case "HEAD /api/source":
      return handleSource(req, res, url.searchParams);
    case "GET /api/video/thumbnails":
      return handleThumbnailsMeta(req, res, url);
    case "GET /api/video/thumbnails/sprite":
    case "HEAD /api/video/thumbnails/sprite":
      return handleThumbnailsSprite(req, res, url);
    case "GET /api/output":
    case "HEAD /api/output":
      return handleOutputInline(req, res);
    case "GET /api/download":
      return handleDownload(req, res);
    case "GET /api/state":
      return handleState(req, res);
    case "GET /api/keys":
      return handleKeys(req, res);
    default:
      return fail(res, 404, `no route for ${key}`);
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    process.stderr.write(`[videostitcher] request error on ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}\n`);
    try {
      if (!res.headersSent) fail(res, 500, err);
      else res.destroy();
    } catch {
      /* response already gone */
    }
  });
});

server.on("clientError", (err, socket) => {
  process.stderr.write(`[videostitcher] client error: ${err}\n`);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// Initialize the project library (migrate legacy → projects/, restore
// the persisted active project) BEFORE accepting requests. Falling
// through on errors is safer than crashing the server — the routes
// handle null activeProjectDir cleanly.
initProjectsLibrary()
  .catch((err) => {
    process.stderr.write(`[projects] init failed (continuing without restored active project): ${err && err.stack ? err.stack : err}\n`);
  })
  .finally(() => {
    server.listen(PORT, HOST, () => {
      process.stdout.write(`videostitcher tile-app server listening on ${PORT} (data dir: ${DATA_DIR}, activeProject: ${activeProjectId || "<none>"})\n`);
    });
  });

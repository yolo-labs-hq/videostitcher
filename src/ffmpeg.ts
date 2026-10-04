import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Resolve the bundled ffmpeg/ffprobe binaries. We bundle them via
 * ffmpeg-static / ffprobe-static so the tool needs no system install.
 * Env overrides (FFMPEG_PATH / FFPROBE_PATH) let a host with a newer ffmpeg
 * opt in to it.
 */
export const FFMPEG_PATH: string =
  process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || "ffmpeg";
export const FFPROBE_PATH: string =
  process.env.FFPROBE_PATH || ffprobeStatic.path || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], onStderr?: (chunk: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      onStderr?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** True if the resolved ffmpeg/ffprobe binaries are actually runnable. */
export async function checkFfmpeg(): Promise<{ ok: boolean; detail: string }> {
  try {
    const v = await run(FFMPEG_PATH, ["-version"]);
    if (v.code !== 0) return { ok: false, detail: `ffmpeg exited ${v.code}` };
    const p = await run(FFPROBE_PATH, ["-version"]);
    if (p.code !== 0) return { ok: false, detail: `ffprobe exited ${p.code}` };
    return { ok: true, detail: v.stdout.split("\n")[0] ?? "ok" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Media duration in seconds via ffprobe. */
export async function probeDuration(path: string): Promise<number> {
  const { code, stdout, stderr } = await run(FFPROBE_PATH, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${stderr.trim()}`);
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur)) throw new Error(`ffprobe returned no duration for ${path}`);
  return dur;
}

/** Pixel dimensions of a media file's first video stream, via ffprobe. */
export async function probeDimensions(path: string): Promise<{ width: number; height: number }> {
  const { code, stdout, stderr } = await run(FFPROBE_PATH, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${stderr.trim()}`);
  const m = /(\d+)\s*x\s*(\d+)/.exec(stdout.trim());
  if (!m) throw new Error(`ffprobe returned no dimensions for ${path}: ${stdout.trim()}`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Run an ffmpeg invocation, throwing with captured stderr tail on failure. */
export async function runFfmpeg(args: string[], onProgress?: (line: string) => void): Promise<void> {
  const { code, stderr } = await run(FFMPEG_PATH, args, onProgress);
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new Error(`ffmpeg exited ${code}:\n${tail}`);
  }
}

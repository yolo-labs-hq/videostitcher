#!/usr/bin/env node
import { Command } from "commander";
import { checkFfmpeg, FFMPEG_PATH, FFPROBE_PATH } from "./ffmpeg.js";
import { initCommand } from "./commands/init.js";
import { mockVoiceCommand } from "./commands/mockVoice.js";
import { stitchCommand } from "./commands/stitchCommand.js";
import { voiceCommand } from "./commands/voice.js";
import { voicesCommand } from "./commands/voices.js";
import { analyzeCommand } from "./commands/analyze.js";
import { scriptCommand } from "./commands/script.js";
import { runCommand } from "./commands/run.js";
import { fail, info, ok } from "./log.js";

const program = new Command();

program
  .name("videostitcher")
  .description("Automated screencast voiceover pipeline (Phase 1: scaffold + stitch)")
  .version("0.5.0");

program
  .command("doctor")
  .description("Check that ffmpeg/ffprobe are available")
  .action(async () => {
    const r = await checkFfmpeg();
    info(`ffmpeg:  ${FFMPEG_PATH}`);
    info(`ffprobe: ${FFPROBE_PATH}`);
    if (r.ok) ok(r.detail);
    else {
      fail(`ffmpeg not usable: ${r.detail}`);
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Run the whole pipeline: init → analyze → script → (review) → voice → stitch")
  .argument("<video>", "path to the source screencast video")
  .option("--brief <textOrFile>", "one-line overview, or a path to a brief file")
  .option("--name <name>", "project name (defaults to the video filename)")
  .option("--dir <dir>", "project directory (defaults to ./projects/<name>)")
  .option("--fps <n>", "Gemini video sampling frames per second", parseFloat)
  .option("--model <id>", "Claude model for the script (default claude-opus-4-7)")
  .option("--effort <level>", "script thinking effort: low|medium|high|xhigh|max")
  .option("--voice <id>", "ElevenLabs voice id (or set voice.voiceId in timeline.json)")
  .option("--out <path>", "output path (defaults to <projectDir>/out/final.mp4)")
  .option("--force", "redo analyze + script even if their artifacts exist")
  .option("--revoice", "regenerate voice clips even if they exist on disk (re-bills)")
  .option("-y, --yes", "non-interactive: skip the review pause and voice cost prompt")
  .action(async (video, opts) => {
    await runCommand(video, opts);
  });

program
  .command("init")
  .description("Create a project directory for a source video")
  .argument("<video>", "path to the source screencast video")
  .option("--brief <textOrFile>", "one-line overview, or a path to a brief file")
  .option("--name <name>", "project name (defaults to the video filename)")
  .option("--dir <dir>", "project directory (defaults to ./projects/<name>)")
  .option("--scaffold-script", "also write a starter script.json spanning the whole video")
  .action(async (video, opts) => {
    await initCommand(video, opts);
  });

program
  .command("mock-voice")
  .description("Render silent placeholder narration from script.json so stitch can be tested offline")
  .argument("<projectDir>", "project directory")
  .option("--words-per-sec <n>", "spoken pace for length estimation", parseFloat)
  .option("--min-sec <n>", "minimum clip length", parseFloat)
  .action(async (projectDir, opts) => {
    await mockVoiceCommand(projectDir, {
      wordsPerSec: opts.wordsPerSec,
      minSec: opts.minSec,
    });
  });

program
  .command("stitch")
  .description("Assemble the final video: source footage + narration audio overlaid at each clip's startSec")
  .argument("<projectDir>", "project directory")
  .option("--out <path>", "output path (defaults to <projectDir>/out/final.mp4)")
  .action(async (projectDir, opts) => {
    await stitchCommand(projectDir, opts);
  });

program
  .command("voices")
  .description("List the ElevenLabs voices available on your account")
  .option("--api-key <key>", "ElevenLabs API key (defaults to VIDEOSTITCHER_ELEVENLABS_API_KEY)")
  .action(async (opts) => {
    await voicesCommand(opts);
  });

program
  .command("voice")
  .description("Render narration audio (ElevenLabs) into the timeline's narration[*].audio")
  .argument("<projectDir>", "project directory")
  .option("--voice <id>", "voice id (overrides timeline.json voice.voiceId)")
  .option("--model-id <id>", "TTS model id (overrides timeline.json voice.modelId)")
  .option("--api-key <key>", "ElevenLabs API key (defaults to VIDEOSTITCHER_ELEVENLABS_API_KEY)")
  .option("--output-format <fmt>", "ElevenLabs output format (default mp3_44100_128)")
  .option(
    "--ids <list>",
    "comma-separated narration ids to render (default: all clips with text)",
    (val) => val.split(",").map((s) => s.trim()).filter(Boolean),
  )
  .option("--force", "re-render clips even if their narrationHash already matches")
  .option("--dry-run", "estimate character cost without calling the API")
  .option("-y, --yes", "skip the cost confirmation prompt")
  .action(async (projectDir, opts) => {
    await voiceCommand(projectDir, opts);
  });

program
  .command("analyze")
  .description("Analyze the video with Gemini → analysis.json (timestamped segments)")
  .argument("<projectDir>", "project directory")
  .option("--model <id>", "Gemini model (default gemini-2.5-flash)")
  .option("--api-key <key>", "Gemini API key (defaults to VIDEOSTITCHER_GEMINI_API_KEY)")
  .option("--fps <n>", "video sampling frames per second (higher catches fast UI changes)", parseFloat)
  .option("--draft-script", "also write a placeholder script.json from the analysis (rewrite before voicing)")
  .option("--force", "re-analyze even if analysis.json exists (will re-bill Gemini)")
  .action(async (projectDir, opts) => {
    await analyzeCommand(projectDir, opts);
  });

program
  .command("script")
  .description("Write narration from analysis.json with Claude → timeline.json (the review handoff)")
  .argument("<projectDir>", "project directory")
  .option("--model <id>", "Claude model (default claude-opus-4-7)")
  .option("--api-key <key>", "Anthropic API key (defaults to VIDEOSTITCHER_ANTHROPIC_API_KEY)")
  .option("--effort <level>", "thinking effort: low|medium|high|xhigh|max (default high)")
  .option("--force", "overwrite an existing timeline.json (discards manual edits)")
  .option("--dry-run", "estimate token cost without generating a script (free /count_tokens call)")
  .action(async (projectDir, opts) => {
    await scriptCommand(projectDir, opts);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  fail(err.message);
  process.exitCode = 1;
});

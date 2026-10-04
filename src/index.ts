/**
 * Library barrel — exposes the videostitcher pipeline stage functions + project
 * helpers + types so the tile-app server (server/server.mjs) can drive the
 * pipeline programmatically instead of shelling out to the CLI.
 */

export { initCommand } from './commands/init.js';
export { analyzeCommand, normalizeAnalysisSegments } from './commands/analyze.js';
export { scriptCommand } from './commands/script.js';
export { voiceCommand } from './commands/voice.js';
export { mockVoiceCommand } from './commands/mockVoice.js';
export { stitchCommand } from './commands/stitchCommand.js';

export { buildTimelineFromAnalysis } from './script-build.js';
export {
  FILES, projectPath,
  loadProject, saveProject,
  loadAnalysis,
  loadTimeline, saveTimeline,
  ensureDir,
} from './project.js';
export {
  helpWriteNarration,
  deriveSceneContext,
  buildHelpPrompt,
  type HelpMode,
  type HelpWriteResult,
  type NeighborContext,
  type NarrationSuggestion,
} from './claude.js';
export { narrationHash, estimateNarrationDurationSec } from './narrationHash.js';
export { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg.js';

export * from './types.js';

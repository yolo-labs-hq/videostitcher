import { listVoices, resolveApiKey } from "../elevenlabs.js";
import { info, ok } from "../log.js";

export interface VoicesCommandOptions {
  apiKey?: string;
}

export async function voicesCommand(opts: VoicesCommandOptions): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey);
  const voices = await listVoices(apiKey);
  if (voices.length === 0) {
    info("no voices found on this account");
    return;
  }
  ok(`${voices.length} voice(s):`);
  info("");
  for (const v of voices) {
    info(`  ${v.voiceId}  ${v.name}${v.category ? `  (${v.category})` : ""}`);
  }
  info("");
  info("Set one in script.json as voice.voiceId, or pass --voice <id> to the voice command.");
}

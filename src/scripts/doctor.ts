import { access } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { run } from '../util/exec.js';

/** Checks every external dependency the configured providers need. */
const cfg = loadConfig();
const checks: Array<[string, () => Promise<string>]> = [
  ['postgres', async () => {
    const db = createDb(cfg.DATABASE_URL);
    try {
      return (await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v;
    } finally {
      await db.end();
    }
  }],
  ['ffmpeg', async () => (await run(cfg.FFMPEG_BIN, ['-version'])).stdout.split('\n')[0]!],
  ['ffprobe', async () => (await run(cfg.FFPROBE_BIN, ['-version'])).stdout.split('\n')[0]!],
];
if (cfg.MEDIA_PROVIDER === 'yt_dlp') checks.push(['yt-dlp', async () => (await run(cfg.YT_DLP_BIN, ['--version'])).stdout.trim()]);
if (cfg.TRANSCRIPTION_PROVIDER === 'whisper_cpp') {
  checks.push(['whisper-cli', async () => ((await run(cfg.WHISPER_CPP_BIN, ['--help'])).code === 0 ? 'ok' : 'error')]);
  checks.push(['whisper model', async () => (await access(cfg.WHISPER_MODEL_PATH), cfg.WHISPER_MODEL_PATH)]);
  checks.push(['vad model (optional)', async () => (await access(cfg.WHISPER_VAD_MODEL_PATH), cfg.WHISPER_VAD_MODEL_PATH)]);
}
checks.push(['discovery provider', async () => {
  if (cfg.DISCOVERY_PROVIDER === 'none') throw new Error('none: only reelUrls imports will work (see README "Discovery")');
  return cfg.DISCOVERY_PROVIDER;
}]);

let failed = 0;
for (const [name, check] of checks) {
  try {
    console.log(`✔ ${name}: ${await check()}`);
  } catch (err) {
    if (!name.includes('optional') && name !== 'discovery provider') failed++;
    console.log(`✘ ${name}: ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  // The API has no auth of its own; keep it on localhost unless it sits behind your app's gateway.
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  DATA_DIR: z.string().default('./data'),

  // Discovery: which provider resolves a profile URL into Reels.
  DISCOVERY_PROVIDER: z.enum(['meta_business_discovery', 'apify_reel_scraper', 'none']).default('none'),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_ACCESS_TOKEN: z.string().optional(),
  META_IG_USER_ID: z.string().optional(),

  APIFY_TOKEN: z.string().optional(),
  APIFY_REEL_SCRAPER_ACTOR: z.string().default('apify~instagram-reel-scraper'),
  APIFY_REEL_SCRAPER_USD_PER_1000: z.coerce.number().default(2.6),
  APIFY_AUDIO_ACTOR: z.string().default('maximedupre~instagram-reels-audio-downloader'),
  APIFY_AUDIO_USD_PER_1000: z.coerce.number().default(0.01),

  // Per-reel metadata + audio.
  MEDIA_PROVIDER: z.enum(['yt_dlp', 'apify_audio']).default('yt_dlp'),
  YT_DLP_BIN: z.string().default('yt-dlp'),
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),
  // Minimum gap between Instagram requests from this worker. Polite pacing, not evasion.
  MEDIA_MIN_INTERVAL_MS: z.coerce.number().int().default(4000),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).default(1),

  // Transcription.
  TRANSCRIPTION_PROVIDER: z.enum(['whisper_cpp', 'openai_compatible']).default('whisper_cpp'),
  WHISPER_CPP_BIN: z.string().default('whisper-cli'),
  WHISPER_MODEL_PATH: z.string().default('./models/ggml-large-v3-turbo-q5_0.bin'),
  WHISPER_VAD_MODEL_PATH: z.string().default('./models/ggml-silero-v5.1.2.bin'),
  WHISPER_THREADS: z.coerce.number().int().default(4),
  WHISPER_LANGUAGE: z.string().default('auto'),
  // Applied when Hindi/Urdu is detected; keeps English words in Latin script (Hinglish).
  WHISPER_HINGLISH_PROMPT: z
    .string()
    .default('Doston, aaj ka video Instagram reels ke baare mein hai. Hook, content aur call to action.'),
  // Also produce an English transcript for non-English speech (original is always kept).
  TRANSLATE_TO_ENGLISH: bool.default(true),
  WHISPER_TRANSLATE_MODEL_PATH: z.string().default('./models/ggml-large-v3-q5_0.bin'),
  // large-v3-turbo skips large parts of fast Hindi speech; Hindi/Urdu originals use this model instead.
  WHISPER_HINDI_MODEL_PATH: z.string().default('./models/ggml-large-v3-q5_0.bin'),
  // 2 is ~20% faster than 1 on an M4; 4 is slower (GPU contention). Changeable from the UI.
  TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),

  OPENAI_COMPAT_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_MODEL: z.string().default('whisper-1'),
  OPENAI_COMPAT_USD_PER_MINUTE: z.coerce.number().default(0.006),

  // Base delay for exponential backoff on throttling / transient errors.
  RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).default(30),
  METRICS_STALE_AFTER_HOURS: z.coerce.number().default(72),
  KEEP_AUDIO_FILES: bool.default(true),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

import type { Config } from '../config.js';
import { ApifyReelScraperProvider } from './discovery/apifyReelScraper.js';
import { MetaBusinessDiscoveryProvider } from './discovery/metaBusinessDiscovery.js';
import { ApifyAudioProvider } from './media/apifyAudio.js';
import { YtDlpMediaProvider } from './media/ytDlp.js';
import { OpenAICompatibleTranscriber } from './transcription/openaiCompatible.js';
import { WhisperCppTranscriber } from './transcription/whisperCpp.js';
import type { DiscoveryProvider, ReelMediaProvider, TranscriptionProvider } from './types.js';

export interface Providers {
  discovery: DiscoveryProvider | null;
  media: ReelMediaProvider;
  transcription: TranscriptionProvider;
}

function required(value: string | undefined, name: string, forWhat: string): string {
  if (!value) throw new Error(`${name} is required when ${forWhat}`);
  return value;
}

export function createProviders(cfg: Config): Providers {
  let discovery: DiscoveryProvider | null = null;
  if (cfg.DISCOVERY_PROVIDER === 'meta_business_discovery') {
    discovery = new MetaBusinessDiscoveryProvider({
      accessToken: required(cfg.META_ACCESS_TOKEN, 'META_ACCESS_TOKEN', 'DISCOVERY_PROVIDER=meta_business_discovery'),
      igUserId: required(cfg.META_IG_USER_ID, 'META_IG_USER_ID', 'DISCOVERY_PROVIDER=meta_business_discovery'),
      version: cfg.META_GRAPH_VERSION,
    });
  } else if (cfg.DISCOVERY_PROVIDER === 'apify_reel_scraper') {
    discovery = new ApifyReelScraperProvider({
      token: required(cfg.APIFY_TOKEN, 'APIFY_TOKEN', 'DISCOVERY_PROVIDER=apify_reel_scraper'),
      actor: cfg.APIFY_REEL_SCRAPER_ACTOR,
      usdPer1000: cfg.APIFY_REEL_SCRAPER_USD_PER_1000,
    });
  }

  const media: ReelMediaProvider =
    cfg.MEDIA_PROVIDER === 'apify_audio'
      ? new ApifyAudioProvider({ token: required(cfg.APIFY_TOKEN, 'APIFY_TOKEN', 'MEDIA_PROVIDER=apify_audio'), actor: cfg.APIFY_AUDIO_ACTOR, usdPer1000: cfg.APIFY_AUDIO_USD_PER_1000 })
      : new YtDlpMediaProvider({ bin: cfg.YT_DLP_BIN, minIntervalMs: cfg.MEDIA_MIN_INTERVAL_MS });

  const transcription: TranscriptionProvider =
    cfg.TRANSCRIPTION_PROVIDER === 'openai_compatible'
      ? new OpenAICompatibleTranscriber({
          baseUrl: cfg.OPENAI_COMPAT_BASE_URL,
          apiKey: required(cfg.OPENAI_COMPAT_API_KEY, 'OPENAI_COMPAT_API_KEY', 'TRANSCRIPTION_PROVIDER=openai_compatible'),
          model: cfg.OPENAI_COMPAT_MODEL,
          usdPerMinute: cfg.OPENAI_COMPAT_USD_PER_MINUTE,
          translate: cfg.TRANSLATE_TO_ENGLISH,
        })
      : new WhisperCppTranscriber({
          bin: cfg.WHISPER_CPP_BIN,
          modelPath: cfg.WHISPER_MODEL_PATH,
          vadModelPath: cfg.WHISPER_VAD_MODEL_PATH,
          threads: cfg.WHISPER_THREADS,
          language: cfg.WHISPER_LANGUAGE,
          hinglishPrompt: cfg.WHISPER_HINGLISH_PROMPT,
          translateModelPath: cfg.TRANSLATE_TO_ENGLISH ? cfg.WHISPER_TRANSLATE_MODEL_PATH : null,
          hindiModelPath: cfg.WHISPER_HINDI_MODEL_PATH,
        });

  return { discovery, media, transcription };
}

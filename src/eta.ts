import type { TaskStage } from './repository.js';

// Used until this machine has its own history (measured on an Apple M4, Oct 2026,
// with English translation on: ~0.35–1.15 s of processing per second of audio).
const DEFAULT_FETCH_MS = 5_000;
const DEFAULT_MS_PER_AUDIO_SECOND = 600;
const DEFAULT_REEL_SECONDS = 45;

export interface Eta {
  /** null while discovery is still running (the number of reels is not known yet). */
  secondsRemaining: number | null;
  /** 'history' once this machine has timings; 'default' before that. */
  basis: 'history' | 'default' | 'done' | 'discovering';
  avgDownloadSeconds: number;
  /** Seconds of processing per second of audio (transcription + translation). */
  transcribeSecondsPerAudioSecond: number;
}

export interface EtaTask {
  stage: TaskStage;
  /** Known once the audio is downloaded. */
  durationSeconds: number | null;
  /** How long the current transcription has been running (stage = transcribing). */
  transcribingForMs: number | null;
  /** Known up front not to need transcription (e.g. below the import's view threshold). */
  skipTranscription?: boolean;
}

/**
 * Downloads run serially (paced) while transcription runs on its own queue, so
 * the two overlap: remaining ≈ max(download backlog + first transcription, transcription backlog).
 * Transcription time scales with audio length, so each reel is estimated from its own duration.
 */
export function estimateRemaining(input: {
  status: string;
  tasks: EtaTask[];
  transcribe: boolean;
  avgFetchMs: number | null;
  transcribeMsPerAudioSecond: number | null;
  avgReelSeconds: number | null;
  mediaConcurrency: number;
  transcriptionConcurrency: number;
}): Eta {
  const fetchMs = input.avgFetchMs ?? DEFAULT_FETCH_MS;
  const rate = input.transcribeMsPerAudioSecond ?? DEFAULT_MS_PER_AUDIO_SECOND;
  const reelSeconds = input.avgReelSeconds ?? DEFAULT_REEL_SECONDS;
  const base = {
    avgDownloadSeconds: Math.round(fetchMs / 100) / 10,
    transcribeSecondsPerAudioSecond: Math.round(rate / 10) / 100,
  };
  if (input.status === 'queued' || input.status === 'discovering') return { ...base, secondsRemaining: null, basis: 'discovering' };
  if (['completed', 'partial', 'failed'].includes(input.status)) return { ...base, secondsRemaining: 0, basis: 'done' };

  const notDownloaded = input.tasks.filter((t) => t.stage === 'queued' || t.stage === 'fetching');
  const fetchBacklog = (notDownloaded.length * fetchMs) / input.mediaConcurrency;

  let transcribeBacklog = 0;
  let nextTranscription = 0;
  if (input.transcribe) {
    for (const t of input.tasks) {
      if (['done', 'failed', 'skipped'].includes(t.stage) || t.skipTranscription) continue;
      const total = (t.durationSeconds ?? reelSeconds) * rate;
      // Count down the reel in progress, but never below a few seconds (it isn't finished yet).
      const left = t.stage === 'transcribing' ? Math.max(total - (t.transcribingForMs ?? 0), 3_000) : total;
      transcribeBacklog += left;
      if (t.stage === 'queued' || t.stage === 'fetching') nextTranscription = Math.max(nextTranscription, total);
    }
    transcribeBacklog /= input.transcriptionConcurrency;
  }

  const ms = Math.max(fetchBacklog + (notDownloaded.length ? nextTranscription : 0), transcribeBacklog);
  return {
    ...base,
    secondsRemaining: Math.ceil(ms / 1000),
    basis: input.avgFetchMs !== null && (input.transcribeMsPerAudioSecond !== null || !input.transcribe) ? 'history' : 'default',
  };
}

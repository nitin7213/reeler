/**
 * Provider contracts. Each external dependency (discovery, media, speech-to-text)
 * sits behind one of these so it can be swapped without touching the pipeline.
 */

export type ProviderErrorKind =
  | 'private' // profile or reel is private
  | 'not_found' // deleted, removed or never existed
  | 'unavailable' // source returned nothing logged-out: deleted, private, age/region-restricted (indistinguishable)
  | 'login_required' // source refuses logged-out access; we do not work around this
  | 'throttled' // 429 / "please wait": back off, do not rotate identities
  | 'no_audio'
  | 'config' // missing token, binary, model
  | 'transient' // network / 5xx
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Worth retrying later with backoff. */
  get retryable(): boolean {
    return this.kind === 'throttled' || this.kind === 'transient' || this.kind === 'unknown';
  }
}

/** Every metric is nullable: null means "not provided by this source", never zero. */
export interface ReelMetrics {
  views: number | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  metricsHidden: boolean | null;
  /** Rounded display values (e.g. "1.4m" from the profile grid), not exact counts. */
  approximate?: boolean;
}

export interface ReelRecord {
  shortcode: string;
  url: string;
  platformMediaId?: string | null;
  ownerUsername?: string | null;
  caption?: string | null;
  publishedAt?: Date | null;
  durationSeconds?: number | null;
  hasAudio?: boolean | null;
  metrics: ReelMetrics;
}

export interface ProfileInfo {
  username: string;
  platformUserId?: string | null;
  displayName?: string | null;
  isPrivate?: boolean | null;
  /** Total media the source reports for the account (all types). Used for coverage checks. */
  reportedMediaCount?: number | null;
}

export interface DiscoveryPage {
  reels: ReelRecord[];
  /** Opaque cursor; null when the source says there is nothing more. */
  nextCursor: string | null;
}

export interface CostEntry {
  provider: string;
  operation: 'discovery' | 'audio' | 'transcription';
  units: number;
  unit: 'requests' | 'results' | 'audio_minutes';
  costUsd: number;
}

export interface DiscoveryProvider {
  readonly name: string;
  /** Hard ceiling of reels this source can return per profile, if any (e.g. API window). */
  readonly maxReachableNote?: string;
  getProfile(username: string): Promise<ProfileInfo>;
  /** Paginate reels. Implementations must only return product_type=Reels/clips. */
  listReels(username: string, cursor: string | null, opts: { limit: number }): Promise<DiscoveryPage & { cost: CostEntry[]; scannedMedia: number }>;
}

export interface ReelMediaResult {
  record: ReelRecord;
  /** Local path to the downloaded original audio (or video if no audio-only stream). */
  mediaPath: string | null;
  cost: CostEntry[];
}

export interface ReelMediaProvider {
  readonly name: string;
  /** Fetch per-reel metadata and download its audio into `workDir`. */
  fetchReel(shortcode: string, workDir: string, opts: { downloadAudio: boolean; signal?: AbortSignal }): Promise<ReelMediaResult>;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  status: 'completed' | 'no_speech';
  language: string | null;
  languageProbability: number | null;
  text: string;
  segments: TranscriptSegment[];
  /** English version: the original when already English, a translation otherwise, null if disabled/no speech. */
  english: { text: string; segments: TranscriptSegment[] } | null;
  costUsd: number;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  /** True for providers that run elsewhere and can take many parallel requests. */
  readonly hosted?: boolean;
  /** `wavPath` is 16 kHz mono PCM. */
  transcribe(wavPath: string, durationSeconds: number, signal?: AbortSignal): Promise<TranscriptionResult>;
}

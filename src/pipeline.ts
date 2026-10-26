import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Job, PgBoss } from 'pg-boss';
import { normalizeToWav, probeDurationSeconds, sha256File } from './audio/ffmpeg.js';
import type { Config } from './config.js';
import { canonicalReelUrl } from './instagram/urls.js';
import type { Logger } from './logger.js';
import type { Providers } from './providers/index.js';
import { ProviderError, type ReelRecord } from './providers/types.js';
import type { Coverage, ImportJobRow, Repository } from './repository.js';
import { CancelledError } from './util/exec.js';

export const QUEUES = {
  discover: 'reel-discover',
  fetch: 'reel-fetch',
  transcribe: 'reel-transcribe',
} as const;


interface DiscoverData { importId: string }
interface ReelData { importId: string; reelId: number; shortcode: string }

const RETRY_LIMIT = 4;

const SKIP_KINDS = new Set(['private', 'not_found', 'unavailable', 'no_audio']);

function asProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError ? err : new ProviderError('unknown', (err as Error)?.message ?? String(err), 'internal');
}

export class Pipeline {
  private readonly retry;
  /** In-flight reel steps in this process, keyed by `${importId}:${reelId}`, so Stop can kill them. */
  private readonly running = new Map<string, AbortController>();

  private track(importId: string, reelId: number): AbortController {
    const c = new AbortController();
    this.running.set(`${importId}:${reelId}`, c);
    return c;
  }

  constructor(
    private readonly cfg: Config,
    private readonly repo: Repository,
    private readonly boss: PgBoss,
    private readonly providers: Providers,
    private readonly log: Logger,
  ) {
    this.retry = { retryLimit: RETRY_LIMIT, retryDelay: cfg.RETRY_DELAY_SECONDS, retryBackoff: true, retryDelayMax: 900 };
  }

  async registerQueues(): Promise<void> {
    for (const name of Object.values(QUEUES)) {
      if (!(await this.boss.getQueue(name))) await this.boss.createQueue(name, { ...this.retry });
    }
  }

  private transcriptionConcurrency = 1;

  async startWorkers(transcriptionConcurrency = this.cfg.TRANSCRIPTION_CONCURRENCY): Promise<void> {
    await this.boss.work<DiscoverData>(QUEUES.discover, { localConcurrency: 1 }, async ([job]) => this.onDiscover(job!));
    await this.boss.work<ReelData>(QUEUES.fetch, { localConcurrency: this.cfg.MEDIA_CONCURRENCY }, async ([job]) => this.onFetch(job!));
    await this.startTranscriptionWorker(transcriptionConcurrency);
  }

  getTranscriptionConcurrency(): number {
    return this.transcriptionConcurrency;
  }

  /** Switch between sequential (1) and parallel (n) transcription without restarting. Running jobs finish first. */
  async startTranscriptionWorker(concurrency: number): Promise<void> {
    if (this.transcriptionWorkerStarted) await this.boss.offWork(QUEUES.transcribe, { wait: true });
    await this.boss.work<ReelData>(QUEUES.transcribe, { localConcurrency: concurrency }, async ([job]) => this.onTranscribe(job!));
    this.transcriptionWorkerStarted = true;
    this.transcriptionConcurrency = concurrency;
    this.log.info({ concurrency }, 'transcription worker started');
  }

  private transcriptionWorkerStarted = false;

  enqueueDiscover(importId: string) {
    return this.boss.send(QUEUES.discover, { importId }, { ...this.retry, singletonKey: importId });
  }

  /** Higher-view reels run first (pg-boss fetches by priority DESC). */
  private enqueueReel(queue: string, data: ReelData, views: number | null = null) {
    const priority = views && views > 0 ? Math.round(Math.log10(views) * 100) : 0;
    return this.boss.send(queue, data, { ...this.retry, priority, singletonKey: `${data.importId}:${data.reelId}` });
  }

  /** Reason a reel is skipped for transcription under the import's view threshold, or null. */
  private async thresholdSkip(imp: ImportJobRow, reelId: number): Promise<string | null> {
    const min = imp.options.transcribeMinViews;
    if (!min) return null;
    const views = await this.repo.bestViews(reelId);
    if (views !== null && views >= min) return null;
    return views === null
      ? `Not transcribed: view count unknown (threshold ${min.toLocaleString('en')} views)`
      : `Not transcribed: ${views.toLocaleString('en')} views is below ${min.toLocaleString('en')}`;
  }

  // ---------------------------------------------------------------- discovery

  private async onDiscover(job: Job<DiscoverData>): Promise<void> {
    const { importId } = job.data;
    const log = this.log.child({ importId, stage: 'discover', attempt: job.retryCount });
    const imp = await this.repo.getImport(importId);
    if (!imp || imp.status === 'cancelled') return;
    await this.repo.updateImport(importId, { status: 'discovering', error: null });

    try {
      const { reels, coverage, notes, profileId } = imp.options.reelUrls?.length ? await this.fromUrlList(imp) : await this.fromProvider(imp, log);
      if (profileId) await this.repo.updateImport(importId, { profile_id: profileId });

      let queued = 0;
      for (const r of reels) {
        const reelId = await this.repo.upsertReel(r, profileId);
        await this.repo.addMetricSnapshot(reelId, r.metrics.approximate ? 'profile_grid' : imp.discovery_provider, r.metrics);
        // ensureTask is idempotent: a retried discovery never duplicates work items.
        if (await this.repo.ensureTask(importId, reelId)) {
          await this.enqueueReel(QUEUES.fetch, { importId, reelId, shortcode: r.shortcode }, r.metrics.views ?? r.metrics.plays);
          queued++;
        }
      }
      await this.repo.updateImport(importId, { status: 'processing', reels_discovered: reels.length, coverage, coverage_notes: notes });
      log.info({ discovered: reels.length, queued, coverage }, 'discovery finished');
      await this.maybeFinalize(importId);
    } catch (err) {
      const e = asProviderError(err);
      log.warn({ kind: e.kind, provider: e.provider, err: e.message }, 'discovery failed');
      if (e.retryable && job.retryCount < RETRY_LIMIT) {
        await this.repo.updateImport(importId, { status: 'queued', error: `${e.kind}: ${e.message} (will retry)` });
        throw e;
      }
      await this.repo.updateImport(importId, { status: 'failed', error: `${e.kind}: ${e.message}` });
    }
  }

  private async fromUrlList(imp: ImportJobRow) {
    const observed = imp.options.observedMetrics ?? {};
    const reels: ReelRecord[] = imp.options.reelUrls!.map((shortcode) => {
      const o = observed[shortcode];
      return {
        shortcode,
        url: canonicalReelUrl(shortcode),
        metrics: {
          views: o?.views ?? null,
          plays: null,
          likes: o?.likes ?? null,
          comments: o?.comments ?? null,
          metricsHidden: null,
          approximate: Boolean(o),
        },
      };
    });
    return {
      reels,
      coverage: 'user_supplied' as Coverage,
      notes: [`${reels.length} Reel URL(s) supplied by the caller; no profile-wide discovery was performed.`],
      profileId: imp.profile_id,
    };
  }

  private async fromProvider(imp: ImportJobRow, log: Logger) {
    const discovery = this.providers.discovery;
    if (!discovery) {
      throw new ProviderError(
        'config',
        'No discovery provider is configured. Instagram blocks logged-out profile listing, so profile-wide discovery needs ' +
          'DISCOVERY_PROVIDER=meta_business_discovery (free, official) or apify_reel_scraper (paid). Alternatively pass `reelUrls`.',
        'none',
      );
    }
    const username = imp.source_url.replace(/^instagram:@/, '');
    const profile = await discovery.getProfile(username);
    const profileId = await this.repo.upsertProfile(profile);
    if (profile.isPrivate) throw new ProviderError('private', `@${username} is private; only public data is collected.`, discovery.name);

    const reels: ReelRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let scanned = 0;
    let exhausted = false;
    do {
      const page = await discovery.listReels(username, cursor, { limit: Math.min(50, imp.options.maxReels - reels.length) });
      for (const c of page.cost) await this.repo.recordCost(imp.id, null, c);
      scanned += page.scannedMedia;
      for (const r of page.reels) {
        if (seen.has(r.shortcode) || reels.length >= imp.options.maxReels) continue;
        seen.add(r.shortcode);
        reels.push(r);
      }
      cursor = page.nextCursor;
      exhausted = cursor === null;
      log.debug({ scanned, reels: reels.length }, 'discovery page');
    } while (cursor && reels.length < imp.options.maxReels);

    const notes: string[] = [];
    let coverage: Coverage = 'unknown';
    if (!exhausted) {
      coverage = 'partial';
      notes.push(`Stopped at maxReels=${imp.options.maxReels}; the profile has more posts that were not scanned.`);
    } else if (profile.reportedMediaCount != null) {
      coverage = scanned >= profile.reportedMediaCount ? 'complete' : 'partial';
      notes.push(`Scanned ${scanned} of ${profile.reportedMediaCount} posts reported by ${discovery.name}; ${reels.length} were Reels.`);
    } else {
      notes.push(`${discovery.name} returned ${reels.length} Reel(s). ${discovery.maxReachableNote ?? 'Completeness cannot be verified.'}`);
    }
    return { reels, coverage, notes, profileId };
  }

  // ------------------------------------------------------- fetch + audio

  private async onFetch(job: Job<ReelData>): Promise<void> {
    const { importId, reelId, shortcode } = job.data;
    const log = this.log.child({ importId, reelId, shortcode, stage: 'fetch', attempt: job.retryCount });
    const imp = await this.repo.getImport(importId);
    if (!imp || imp.status === 'cancelled') return;
    await this.repo.setTaskStage(importId, reelId, 'fetching');

    const ctl = this.track(importId, reelId);
    const fetchStarted = Date.now();
    const workDir = path.resolve(this.cfg.DATA_DIR, 'tmp', `${shortcode}-${job.id}`);
    await mkdir(workDir, { recursive: true });
    try {
      const existing = await this.repo.getAudioAsset(reelId);
      const haveAudio = existing ? await stat(existing.path).then(() => true, () => false) : false;
      let transcribe = imp.options.transcribe;
      const skipNote = transcribe ? await this.thresholdSkip(imp, reelId) : null;
      if (skipNote) transcribe = false;
      const needAudio = transcribe && !haveAudio;

      const res = await this.providers.media.fetchReel(shortcode, workDir, { downloadAudio: needAudio, signal: ctl.signal });
      if (ctl.signal.aborted) throw new CancelledError();
      for (const c of res.cost) await this.repo.recordCost(importId, reelId, c);
      await this.repo.upsertReel(res.record, imp.profile_id);
      if (res.record.ownerUsername) {
        await this.repo.upsertProfile({ username: res.record.ownerUsername });
        await this.repo.linkReelToProfile(reelId, res.record.ownerUsername);
      }
      await this.repo.addMetricSnapshot(reelId, this.providers.media.name, res.record.metrics);

      if (needAudio) {
        if (!res.mediaPath) throw new ProviderError('no_audio', 'provider returned no media file', this.providers.media.name);
        await this.repo.setTaskStage(importId, reelId, 'extracting_audio');
        const audioDir = path.resolve(this.cfg.DATA_DIR, 'audio');
        await mkdir(audioDir, { recursive: true });
        const wav = path.join(audioDir, `${shortcode}.wav`);
        await normalizeToWav(this.cfg.FFMPEG_BIN, res.mediaPath, wav);
        const duration = await probeDurationSeconds(this.cfg.FFPROBE_BIN, wav);
        const { sha256, bytes } = await sha256File(wav);
        await this.repo.saveAudioAsset({ reelId, provider: this.providers.media.name, sha256, path: wav, durationSeconds: duration, bytes });
        if (duration) await this.repo.setReelDuration(reelId, duration);
      }

      await this.repo.setTaskTiming(importId, reelId, { fetchMs: Date.now() - fetchStarted });
      if (ctl.signal.aborted) throw new CancelledError();
      if (transcribe) {
        await this.repo.setTaskStage(importId, reelId, 'waiting_transcription');
        await this.enqueueReel(QUEUES.transcribe, job.data, await this.repo.bestViews(reelId));
      } else {
        await this.finishTask(importId, reelId, 'done', skipNote ? { kind: 'not_transcribed', message: skipNote } : undefined);
      }
      log.info({ audio: needAudio ? 'downloaded' : haveAudio ? 'cached' : 'skipped' }, 'reel fetched');
    } catch (err) {
      await this.handleTaskError(err, job, log);
    } finally {
      this.running.delete(`${importId}:${reelId}`);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------- transcription

  private async onTranscribe(job: Job<ReelData>): Promise<void> {
    const { importId, reelId } = job.data;
    const log = this.log.child({ importId, reelId, shortcode: job.data.shortcode, stage: 'transcribe', attempt: job.retryCount });
    const stt = this.providers.transcription;
    const imp = await this.repo.getImport(importId);
    if (!imp) return;
    if (imp.status === 'cancelled') {
      await this.repo.setTaskStage(importId, reelId, 'skipped', { kind: 'cancelled', message: 'Stopped by user' });
      return;
    }
    const ctl = this.track(importId, reelId);
    try {
      const audio = await this.repo.getAudioAsset(reelId);
      if (!audio) throw new ProviderError('no_audio', 'no extracted audio for reel', 'internal');

      // The threshold can be raised while an import runs; re-check before spending time on it.
      const skipNote = await this.thresholdSkip(imp, reelId);
      if (skipNote) {
        await this.finishTask(importId, reelId, 'done', { kind: 'not_transcribed', message: skipNote });
        log.info({ note: skipNote }, 'transcription skipped by view threshold');
        return;
      }

      const minutes = (audio.duration_seconds ?? 0) / 60;
      await this.repo.setTaskStage(importId, reelId, 'transcribing');
      const cached = await this.repo.getCachedTranscript(audio.sha256, stt.name, stt.model);
      if (cached) {
        await this.repo.recordCost(importId, reelId, { provider: stt.name, operation: 'transcription', units: minutes, unit: 'audio_minutes', costUsd: 0 }, true);
        await this.repo.setTaskTiming(importId, reelId, { cached: true });
        log.info({ transcriptId: cached.id }, 'transcript cache hit');
        await this.finishTask(importId, reelId, 'done');
        return;
      }

      const started = Date.now();
      try {
        const result = await stt.transcribe(audio.path, audio.duration_seconds ?? 0, ctl.signal);
        await this.repo.saveTranscript({ sha256: audio.sha256, provider: stt.name, model: stt.model, processingMs: Date.now() - started, result });
        await this.repo.recordCost(importId, reelId, { provider: stt.name, operation: 'transcription', units: minutes, unit: 'audio_minutes', costUsd: result.costUsd });
        await this.repo.setTaskTiming(importId, reelId, { transcribeMs: Date.now() - started, cached: false });
        log.info({ status: result.status, language: result.language, ms: Date.now() - started }, 'transcribed');
      } catch (err) {
        // A stopped transcription is not a failure; don't record it as one.
        if (!(err instanceof CancelledError)) {
          await this.repo.saveTranscript({ sha256: audio.sha256, provider: stt.name, model: stt.model, processingMs: Date.now() - started, error: (err as Error).message });
        }
        throw err;
      }
      if (!this.cfg.KEEP_AUDIO_FILES) await rm(audio.path, { force: true });
      await this.finishTask(importId, reelId, 'done');
    } catch (err) {
      await this.handleTaskError(err, job, log);
    } finally {
      this.running.delete(`${importId}:${reelId}`);
    }
  }

  // ------------------------------------------------------------- shared

  private async handleTaskError(err: unknown, job: Job<ReelData>, log: Logger): Promise<void> {
    const { importId, reelId } = job.data;
    if (err instanceof CancelledError || (await this.repo.getImport(importId))?.status === 'cancelled') {
      log.info('reel step stopped by user');
      await this.repo.setTaskStage(importId, reelId, 'skipped', { kind: 'cancelled', message: 'Stopped by user' });
      return;
    }
    const e = asProviderError(err);
    const error = { kind: e.kind, message: e.message };
    if (SKIP_KINDS.has(e.kind)) {
      if (e.kind !== 'no_audio') await this.repo.markReelUnavailable(reelId);
      log.warn({ kind: e.kind, err: e.message }, 'reel skipped');
      await this.finishTask(importId, reelId, 'skipped', error);
      return;
    }
    if (e.retryable && job.retryCount < RETRY_LIMIT) {
      log.warn({ kind: e.kind, err: e.message }, 'reel step failed, will retry');
      await this.repo.setTaskStage(importId, reelId, 'queued', { kind: e.kind, message: `${e.message} (retrying)` });
      throw e; // pg-boss schedules the retry with exponential backoff
    }
    log.error({ kind: e.kind, err: e.message }, 'reel failed');
    await this.finishTask(importId, reelId, 'failed', error);
  }

  private async finishTask(importId: string, reelId: number, stage: 'done' | 'failed' | 'skipped', error?: { kind: string; message: string }) {
    await this.repo.setTaskStage(importId, reelId, stage, error);
    await this.maybeFinalize(importId);
  }

  /** Close the import once every reel task is terminal. Never reports "completed" for a subset. */
  async maybeFinalize(importId: string): Promise<void> {
    if ((await this.repo.pendingTaskCount(importId)) > 0) return;
    const summary = await this.repo.importSummary(importId);
    if (!summary || summary.job.status !== 'processing') return;
    const { stages, job } = summary;
    // 'unknown' coverage is surfaced separately in the status response (collection.complete = null).
    const incomplete = (stages.failed ?? 0) + (stages.skipped ?? 0) > 0 || job.coverage === 'partial';
    await this.repo.updateImport(importId, { status: incomplete ? 'partial' : 'completed' });
  }

  /**
   * Stop an import: queued jobs are cancelled, running yt-dlp/whisper processes are killed,
   * and unfinished reels are marked skipped (kind 'cancelled'). Finished reels and transcripts are kept.
   */
  async cancelImport(importId: string): Promise<{ stopped: number }> {
    await this.repo.updateImport(importId, { status: 'cancelled', error: null });
    for (const [key, ctl] of this.running) if (key.startsWith(`${importId}:`)) ctl.abort();
    const jobs = await this.repo.pendingQueueJobs(importId);
    for (const name of new Set(jobs.map((j) => j.name))) {
      await this.boss.cancel(name, jobs.filter((j) => j.name === name).map((j) => j.id));
    }
    const stopped = await this.repo.cancelUnfinishedTasks(importId);
    this.log.info({ importId, stopped, jobs: jobs.length }, 'import stopped by user');
    return { stopped };
  }

  async retryImport(importId: string): Promise<{ requeued: number; rediscover: boolean }> {
    const imp = await this.repo.getImport(importId);
    if (!imp) throw new Error('import not found');
    if ((imp.status === 'failed' || imp.status === 'cancelled') && imp.reels_discovered === 0) {
      await this.repo.updateImport(importId, { status: 'queued', error: null });
      await this.enqueueDiscover(importId);
      return { requeued: 0, rediscover: true };
    }
    const reset = await this.repo.resetFailedTasks(importId);
    if (reset.length) await this.repo.updateImport(importId, { status: 'processing' });
    for (const r of reset) await this.enqueueReel(QUEUES.fetch, { importId, reelId: r.reel_id, shortcode: r.shortcode });
    return { requeued: reset.length, rediscover: false };
  }
}

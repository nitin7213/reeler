import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { buildProfileReport, type ProfileReport } from './analytics/report.js';
import type { Config } from './config.js';
import { createDb, migrate, type Db } from './db.js';
import { parseProfileUsername, parseReelShortcode } from './instagram/urls.js';
import { estimateRemaining, type Eta } from './eta.js';
import { createLogger, type Logger } from './logger.js';
import { Pipeline } from './pipeline.js';
import { createProviders, type Providers } from './providers/index.js';
import { Repository, type ReelView } from './repository.js';

export class InputError extends Error {}

export interface ImportRequest {
  /** Public profile URL or @username. */
  profileUrl?: string;
  /** Explicit Reel URLs; used instead of (or to scope) profile discovery. */
  reelUrls?: string[];
  maxReels?: number;
  transcribe?: boolean;
  /** Only transcribe reels with at least this many views (others keep metrics only). */
  transcribeMinViews?: number;
  /** Rounded counts seen on the profile grid (from the Collect Reels bookmark), keyed by shortcode. */
  observedMetrics?: Record<string, { views?: number | null; likes?: number | null; comments?: number | null }>;
}

export interface ReelIngest {
  readonly db: Db;
  readonly repo: Repository;
  readonly providers: Providers;
  readonly log: Logger;
  start(opts?: { workers?: boolean }): Promise<void>;
  stop(): Promise<void>;
  importProfile(req: ImportRequest): Promise<{ importId: string; status: string; deduplicated: boolean }>;
  getImportStatus(importId: string): Promise<ImportStatusView | null>;
  retryImport(importId: string): Promise<{ requeued: number; rediscover: boolean }>;
  /** Stop a running import; finished reels and transcripts are kept. Resume with retryImport. */
  cancelImport(importId: string): Promise<{ stopped: number; notRunning?: boolean }>;
  getReels(username: string): Promise<ReelView[]>;
  getReport(username: string): Promise<ProfileReport>;
  listImports(limit?: number): ReturnType<Repository['listImports']>;
  listProfiles(): ReturnType<Repository['listProfiles']>;
  /** Refuses while the import is still running. `withReels` also deletes reels that belong only to this import. */
  deleteImport(importId: string, opts: { withReels: boolean }): Promise<{ deleted: boolean; reelsDeleted: number; running?: boolean }>;
  deleteReel(shortcode: string): Promise<boolean>;
  /** Change the view threshold of an import; applies to reels not yet transcribed. 0/null = transcribe all. */
  setImportMinViews(importId: string, minViews: number | null): Promise<boolean>;
  deleteReels(shortcodes: string[]): Promise<{ deleted: number }>;
  deleteTranscripts(shortcodes: string[]): Promise<{ deleted: number }>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
}

export interface Settings {
  transcriptionMode: 'sequential' | 'parallel';
  /** How many reels are transcribed at once. */
  transcriptionConcurrency: number;
  /** Highest value allowed for the current provider (local whisper shares one GPU). */
  maxTranscriptionConcurrency: number;
  /** Measured best for local whisper.cpp on an M4. */
  recommendedConcurrency: number;
  transcriptionProvider: string;
}

const PARALLEL_TRANSCRIPTIONS = 2;
const MAX_LOCAL_CONCURRENCY = 4;
const MAX_HOSTED_CONCURRENCY = 32;

export function createReelIngest(cfg: Config, deps: { log?: Logger; db?: Db; providers?: Providers } = {}): ReelIngest {
  const log = deps.log ?? createLogger(cfg.LOG_LEVEL);
  const db = deps.db ?? createDb(cfg.DATABASE_URL);
  const repo = new Repository(db);
  const providers = deps.providers ?? createProviders(cfg);
  const boss = new PgBoss({ connectionString: cfg.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  const pipeline = new Pipeline(cfg, repo, boss, providers, log);

  return {
    db,
    repo,
    providers,
    log,

    async start({ workers = true } = {}) {
      await migrate(db);
      await boss.start();
      await pipeline.registerQueues();
      if (workers) {
        const savedN = await repo.getSetting<number>('transcriptionConcurrency');
        const savedMode = await repo.getSetting<Settings['transcriptionMode']>('transcriptionMode');
        const n = savedN ?? (savedMode === 'sequential' ? 1 : savedMode === 'parallel' ? PARALLEL_TRANSCRIPTIONS : cfg.TRANSCRIPTION_CONCURRENCY);
        await pipeline.startWorkers(Math.min(n, providers.transcription.hosted ? MAX_HOSTED_CONCURRENCY : MAX_LOCAL_CONCURRENCY));
      }
      log.info({ workers, discovery: providers.discovery?.name ?? 'none', media: providers.media.name, stt: `${providers.transcription.name}/${providers.transcription.model}` }, 'reel ingest started');
    },

    async stop() {
      await boss.stop({ graceful: true, timeout: 30_000 });
      if (!deps.db) await db.end();
    },

    async importProfile(req) {
      const username = req.profileUrl ? parseProfileUsername(req.profileUrl) : null;
      if (req.profileUrl && !username) throw new InputError(`Not an Instagram profile URL: ${req.profileUrl}`);

      let shortcodes: string[] | undefined;
      if (req.reelUrls?.length) {
        const parsed = req.reelUrls.map((u) => [u, parseReelShortcode(u)] as const);
        const bad = parsed.filter(([, s]) => !s).map(([u]) => u);
        if (bad.length) throw new InputError(`Not Instagram Reel URLs: ${bad.join(', ')}`);
        shortcodes = [...new Set(parsed.map(([, s]) => s!))];
      }
      if (!username && !shortcodes) throw new InputError('Provide profileUrl and/or reelUrls.');

      const sourceKey = shortcodes
        ? `reels:${createHash('sha1').update(shortcodes.slice().sort().join(',')).digest('hex').slice(0, 16)}`
        : `instagram:@${username}`;
      const existing = await repo.findActiveImport(sourceKey);
      if (existing) return { importId: existing.id, status: existing.status, deduplicated: true };

      const profileId = username ? await repo.upsertProfile({ username }) : null;
      const imp = await repo.createImport({
        sourceUrl: sourceKey,
        provider: shortcodes ? 'reel_urls' : (providers.discovery?.name ?? 'none'),
        profileId,
        options: {
          maxReels: Math.min(Math.max(req.maxReels ?? 1000, 1), 5000),
          transcribe: req.transcribe ?? true,
          transcribeMinViews: req.transcribeMinViews && req.transcribeMinViews > 0 ? req.transcribeMinViews : undefined,
          reelUrls: shortcodes,
          observedMetrics: shortcodes && req.observedMetrics
            ? Object.fromEntries(Object.entries(req.observedMetrics).filter(([code]) => shortcodes!.includes(code)))
            : undefined,
        },
      });
      await pipeline.enqueueDiscover(imp.id);
      log.info({ importId: imp.id, sourceKey }, 'import queued');
      return { importId: imp.id, status: imp.status, deduplicated: false };
    },

    async getImportStatus(importId) {
      const s = await repo.importSummary(importId);
      if (!s) return null;
      const total = Object.values(s.stages).reduce((a, b) => a + (b ?? 0), 0);
      const finished = (s.stages.done ?? 0) + (s.stages.failed ?? 0) + (s.stages.skipped ?? 0);
      const avg = await repo.averageTimings();
      const eta = estimateRemaining({
        status: s.job.status,
        tasks: s.tasks.map((t) => {
          const min = s.job.options.transcribeMinViews;
          return { stage: t.stage, durationSeconds: t.duration_seconds, transcribingForMs: t.transcribing_for_ms, skipTranscription: Boolean(min) && (t.views === null || t.views < min!) };
        }),
        transcribe: s.job.options.transcribe,
        avgFetchMs: avg.fetchMs,
        transcribeMsPerAudioSecond: avg.transcribeMsPerAudioSecond,
        avgReelSeconds: avg.reelSeconds,
        mediaConcurrency: cfg.MEDIA_CONCURRENCY,
        transcriptionConcurrency: pipeline.getTranscriptionConcurrency(),
      });
      const end = s.job.finished_at ? new Date(s.job.finished_at).getTime() : Date.now();
      return {
        importId: s.job.id,
        status: s.job.status,
        profile: s.profile?.username ?? null,
        discoveryProvider: s.job.discovery_provider,
        transcribe: s.job.options.transcribe,
        transcribeMinViews: s.job.options.transcribeMinViews ?? null,
        collection: {
          reelsDiscovered: s.job.reels_discovered,
          coverage: s.job.coverage,
          complete: s.job.coverage === 'complete' ? true : s.job.coverage === 'partial' ? false : null,
          notes: s.job.coverage_notes,
        },
        progress: { total, percent: total ? Math.round((100 * finished) / total) : 0, ...s.stages },
        timing: { elapsedSeconds: Math.round((end - new Date(s.job.created_at).getTime()) / 1000), ...eta },
        reels: s.tasks.map((t) => ({
          shortcode: t.shortcode,
          owner: t.owner,
          stage: t.stage,
          attempts: t.attempts,
          durationSeconds: t.duration_seconds,
          downloadSeconds: t.fetch_ms !== null ? +(t.fetch_ms / 1000).toFixed(1) : null,
          transcribeSeconds: t.transcribe_ms !== null ? +(t.transcribe_ms / 1000).toFixed(1) : null,
          transcriptFromCache: t.transcript_cached,
          note: t.note,
          views: t.views,
          stopped: t.error_kind === 'cancelled',
        })),
        failures: s.failures.map((f) => ({ shortcode: f.shortcode, outcome: f.stage, kind: f.error_kind, error: f.error, attempts: f.attempts })),
        costs: {
          totalUsd: +s.costs.reduce((a, c) => a + c.cost_usd, 0).toFixed(6),
          items: s.costs.map((c) => ({ provider: c.provider, operation: c.operation, units: +c.units.toFixed(3), unit: c.unit, cachedUnits: +c.cached_units.toFixed(3), usd: +c.cost_usd.toFixed(6) })),
        },
        error: s.job.error,
        createdAt: s.job.created_at,
        updatedAt: s.job.updated_at,
        finishedAt: s.job.finished_at,
      };
    },

    retryImport: (id) => pipeline.retryImport(id),

    async cancelImport(importId) {
      const imp = await repo.getImport(importId);
      if (!imp || !['queued', 'discovering', 'processing'].includes(imp.status)) return { stopped: 0, notRunning: true };
      return pipeline.cancelImport(importId);
    },

    listImports: (limit = 30) => repo.listImports(limit),
    listProfiles: () => repo.listProfiles(),

    async deleteImport(importId, { withReels }) {
      const imp = await repo.getImport(importId);
      if (!imp) return { deleted: false, reelsDeleted: 0 };
      if (['queued', 'discovering', 'processing'].includes(imp.status)) return { deleted: false, reelsDeleted: 0, running: true };
      let reelsDeleted = 0;
      if (withReels) {
        const { deleted, audioPaths } = await repo.deleteReels(await repo.reelsOnlyInImport(importId));
        reelsDeleted = deleted;
        await Promise.all(audioPaths.map((p) => rm(p, { force: true })));
      }
      await repo.deleteImport(importId);
      log.info({ importId, reelsDeleted }, 'import deleted');
      return { deleted: true, reelsDeleted };
    },

    async deleteReel(shortcode) {
      const id = await repo.reelIdByShortcode(shortcode);
      if (!id) return false;
      const { audioPaths } = await repo.deleteReels([id]);
      await Promise.all(audioPaths.map((p) => rm(p, { force: true })));
      log.info({ shortcode }, 'reel deleted');
      return true;
    },

    async setImportMinViews(importId, minViews) {
      if (!(await repo.getImport(importId))) return false;
      if (minViews && minViews > 0) await repo.patchImportOptions(importId, { transcribeMinViews: minViews });
      else await repo.clearImportMinViews(importId);
      log.info({ importId, minViews }, 'import view threshold changed');
      return true;
    },

    async deleteReels(shortcodes) {
      const { deleted, audioPaths } = await repo.deleteReels(await repo.reelIdsByShortcodes(shortcodes));
      await Promise.all(audioPaths.map((p) => rm(p, { force: true })));
      log.info({ count: deleted }, 'reels deleted');
      return { deleted };
    },

    async deleteTranscripts(shortcodes) {
      const deleted = await repo.deleteTranscriptsForReels(await repo.reelIdsByShortcodes(shortcodes));
      log.info({ count: deleted }, 'transcripts deleted');
      return { deleted };
    },

    async getSettings() {
      const n = pipeline.getTranscriptionConcurrency();
      return {
        transcriptionMode: n > 1 ? 'parallel' : 'sequential',
        transcriptionConcurrency: n,
        maxTranscriptionConcurrency: providers.transcription.hosted ? MAX_HOSTED_CONCURRENCY : MAX_LOCAL_CONCURRENCY,
        recommendedConcurrency: providers.transcription.hosted ? 8 : PARALLEL_TRANSCRIPTIONS,
        transcriptionProvider: providers.transcription.name,
      };
    },

    async updateSettings(patch) {
      const max = providers.transcription.hosted ? MAX_HOSTED_CONCURRENCY : MAX_LOCAL_CONCURRENCY;
      let n = patch.transcriptionConcurrency;
      if (n === undefined && patch.transcriptionMode) n = patch.transcriptionMode === 'parallel' ? PARALLEL_TRANSCRIPTIONS : 1;
      if (n !== undefined) {
        n = Math.min(Math.max(Math.round(n), 1), max);
        await repo.setSetting('transcriptionConcurrency', n);
        await pipeline.startTranscriptionWorker(n);
      }
      return this.getSettings();
    },
    getReels: (username) => repo.reelsForProfile(username.toLowerCase(), cfg.METRICS_STALE_AFTER_HOURS),
    async getReport(username) {
      return buildProfileReport(username.toLowerCase(), await repo.reelsForProfile(username.toLowerCase(), cfg.METRICS_STALE_AFTER_HOURS));
    },
  };
}

export type ImportStatusView = {
  importId: string;
  status: string;
  profile: string | null;
  discoveryProvider: string;
  transcribe: boolean;
  transcribeMinViews: number | null;
  collection: { reelsDiscovered: number; coverage: string; complete: boolean | null; notes: string[] };
  progress: Record<string, number>;
  timing: Eta & { elapsedSeconds: number };
  reels: Array<{ shortcode: string; owner: string | null; stage: string; attempts: number; durationSeconds: number | null; downloadSeconds: number | null; transcribeSeconds: number | null; transcriptFromCache: boolean | null; note: string | null; views: number | null; stopped: boolean }>;
  failures: Array<{ shortcode: string; outcome: string; kind: string; error: string; attempts: number }>;
  costs: { totalUsd: number; items: Array<Record<string, string | number>> };
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

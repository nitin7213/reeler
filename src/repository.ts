import type { Db } from './db.js';
import type { CostEntry, ProfileInfo, ReelMetrics, ReelRecord, TranscriptionResult, TranscriptSegment } from './providers/types.js';

export type ImportStatus = 'queued' | 'discovering' | 'processing' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type Coverage = 'unknown' | 'complete' | 'partial' | 'user_supplied';
export type TaskStage = 'queued' | 'fetching' | 'extracting_audio' | 'waiting_transcription' | 'transcribing' | 'done' | 'failed' | 'skipped';

export interface ImportOptions {
  maxReels: number;
  transcribe: boolean;
  reelUrls?: string[];
  /** Only transcribe reels whose best known view count is at least this; others keep metrics only. */
  transcribeMinViews?: number;
  /** Counts the caller saw on Instagram's profile grid (rounded), keyed by shortcode. */
  observedMetrics?: Record<string, { views?: number | null; likes?: number | null; comments?: number | null }>;
}

export interface ImportJobRow {
  id: string;
  profile_id: number | null;
  source_url: string;
  discovery_provider: string;
  status: ImportStatus;
  reels_discovered: number;
  coverage: Coverage;
  coverage_notes: string[];
  options: ImportOptions;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const TERMINAL_STAGES = `('done','failed','skipped')`;

export class Repository {
  constructor(readonly db: Db) {}

  async upsertProfile(p: ProfileInfo): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO profiles (username, platform_user_id, display_name, is_private, reported_media_count, last_discovered_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (username) DO UPDATE SET
         platform_user_id = COALESCE(EXCLUDED.platform_user_id, profiles.platform_user_id),
         display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
         is_private = COALESCE(EXCLUDED.is_private, profiles.is_private),
         reported_media_count = COALESCE(EXCLUDED.reported_media_count, profiles.reported_media_count),
         last_discovered_at = now(), updated_at = now()
       RETURNING id`,
      [p.username, p.platformUserId ?? null, p.displayName ?? null, p.isPrivate ?? null, p.reportedMediaCount ?? null],
    );
    return rows[0]!.id;
  }

  async findActiveImport(sourceKey: string): Promise<ImportJobRow | null> {
    const { rows } = await this.db.query<ImportJobRow>(
      `SELECT * FROM import_jobs WHERE source_url = $1 AND status IN ('queued','discovering','processing') ORDER BY created_at DESC LIMIT 1`,
      [sourceKey],
    );
    return rows[0] ?? null;
  }

  async createImport(input: { sourceUrl: string; provider: string; profileId: number | null; options: ImportOptions }): Promise<ImportJobRow> {
    const { rows } = await this.db.query<ImportJobRow>(
      `INSERT INTO import_jobs (source_url, discovery_provider, profile_id, options) VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.sourceUrl, input.provider, input.profileId, JSON.stringify(input.options)],
    );
    return rows[0]!;
  }

  /** Merge fields into an import's options (e.g. change the view threshold while it runs). */
  async patchImportOptions(id: string, patch: Partial<ImportOptions>): Promise<void> {
    await this.db.query(`UPDATE import_jobs SET options = options || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(patch)]);
  }

  async clearImportMinViews(id: string): Promise<void> {
    await this.db.query(`UPDATE import_jobs SET options = options - 'transcribeMinViews', updated_at = now() WHERE id = $1`, [id]);
  }

  async getImport(id: string): Promise<ImportJobRow | null> {
    const { rows } = await this.db.query<ImportJobRow>(`SELECT * FROM import_jobs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateImport(
    id: string,
    patch: Partial<Pick<ImportJobRow, 'status' | 'profile_id' | 'reels_discovered' | 'coverage' | 'coverage_notes' | 'error'>>,
  ): Promise<void> {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const terminal = patch.status && ['completed', 'partial', 'failed', 'cancelled'].includes(patch.status);
    await this.db.query(
      `UPDATE import_jobs SET ${sets.join(', ')}, updated_at = now()${terminal ? ', finished_at = now()' : patch.status ? ', finished_at = NULL' : ''} WHERE id = $1`,
      [id, ...keys.map((k) => patch[k])],
    );
  }

  /** Insert or merge a reel. Known values are never overwritten by missing ones. */
  async upsertReel(r: ReelRecord, profileId: number | null): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reels (profile_id, shortcode, url, platform_media_id, owner_username, caption, published_at, duration_seconds, has_audio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (shortcode) DO UPDATE SET
         profile_id = COALESCE(reels.profile_id, EXCLUDED.profile_id),
         platform_media_id = COALESCE(EXCLUDED.platform_media_id, reels.platform_media_id),
         owner_username = COALESCE(EXCLUDED.owner_username, reels.owner_username),
         caption = COALESCE(EXCLUDED.caption, reels.caption),
         published_at = COALESCE(EXCLUDED.published_at, reels.published_at),
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, reels.duration_seconds),
         has_audio = COALESCE(EXCLUDED.has_audio, reels.has_audio),
         last_seen_at = now(), availability = 'available', updated_at = now()
       RETURNING id`,
      [profileId, r.shortcode, r.url, r.platformMediaId ?? null, r.ownerUsername ?? null, r.caption ?? null, r.publishedAt ?? null, r.durationSeconds ?? null, r.hasAudio ?? null],
    );
    return rows[0]!.id;
  }

  async setReelDuration(reelId: number, seconds: number): Promise<void> {
    await this.db.query(`UPDATE reels SET duration_seconds = COALESCE(duration_seconds, $2), updated_at = now() WHERE id = $1`, [reelId, seconds]);
  }

  async markReelUnavailable(reelId: number): Promise<void> {
    await this.db.query(`UPDATE reels SET availability = 'unavailable', updated_at = now() WHERE id = $1`, [reelId]);
  }

  async linkReelToProfile(reelId: number, username: string): Promise<void> {
    await this.db.query(
      `UPDATE reels SET profile_id = p.id FROM profiles p WHERE reels.id = $1 AND reels.profile_id IS NULL AND p.username = $2`,
      [reelId, username],
    );
  }

  async addMetricSnapshot(reelId: number, source: string, m: ReelMetrics): Promise<void> {
    if (m.views === null && m.plays === null && m.likes === null && m.comments === null && m.metricsHidden === null) return;
    await this.db.query(
      `INSERT INTO metric_snapshots (reel_id, source, views, plays, likes, comments, metrics_hidden, approximate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [reelId, source, m.views, m.plays, m.likes, m.comments, m.metricsHidden, m.approximate ?? false],
    );
  }

  /** Returns true when the task is new for this import (dedup across retries). */
  async ensureTask(importId: string, reelId: number): Promise<boolean> {
    const res = await this.db.query(`INSERT INTO reel_tasks (import_job_id, reel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [importId, reelId]);
    return (res.rowCount ?? 0) > 0;
  }

  async setTaskStage(importId: string, reelId: number, stage: TaskStage, error?: { kind: string; message: string }): Promise<void> {
    await this.db.query(
      `UPDATE reel_tasks SET stage = $3, error_kind = $4, error = $5, updated_at = now(),
         attempts = attempts + CASE WHEN $3 = 'fetching' THEN 1 ELSE 0 END,
         transcribe_started_at = CASE WHEN $3 = 'transcribing' THEN now() ELSE transcribe_started_at END
       WHERE import_job_id = $1 AND reel_id = $2`,
      [importId, reelId, stage, error?.kind ?? null, error?.message ?? null],
    );
  }

  async setTaskTiming(importId: string, reelId: number, t: { fetchMs?: number; transcribeMs?: number; cached?: boolean }): Promise<void> {
    await this.db.query(
      `UPDATE reel_tasks SET fetch_ms = COALESCE($3, fetch_ms), transcribe_ms = COALESCE($4, transcribe_ms),
         transcript_cached = COALESCE($5, transcript_cached) WHERE import_job_id = $1 AND reel_id = $2`,
      [importId, reelId, t.fetchMs ?? null, t.transcribeMs ?? null, t.cached ?? null],
    );
  }

  /** Recent average step durations across all imports; null until there is history. */
  /**
   * Recent averages across all imports (null until there is history):
   * download time per reel, transcription time per second of audio, and reel length.
   */
  async averageTimings(): Promise<{ fetchMs: number | null; transcribeMsPerAudioSecond: number | null; reelSeconds: number | null }> {
    const { rows } = await this.db.query<{ fetch_ms: number | null; rate: number | null; reel_s: number | null }>(
      `SELECT (SELECT avg(fetch_ms)::float FROM (SELECT fetch_ms FROM reel_tasks WHERE fetch_ms IS NOT NULL ORDER BY updated_at DESC LIMIT 50) f) AS fetch_ms,
              (SELECT (sum(t.transcribe_ms) / NULLIF(sum(r.duration_seconds), 0))::float FROM (
                 SELECT transcribe_ms, reel_id FROM reel_tasks WHERE transcribe_ms IS NOT NULL AND transcript_cached IS NOT TRUE ORDER BY updated_at DESC LIMIT 50) t
               JOIN reels r ON r.id = t.reel_id WHERE r.duration_seconds > 0) AS rate,
              (SELECT avg(duration_seconds)::float FROM reels WHERE duration_seconds > 0) AS reel_s`,
    );
    return { fetchMs: rows[0]!.fetch_ms, transcribeMsPerAudioSecond: rows[0]!.rate, reelSeconds: rows[0]!.reel_s };
  }

  async resetFailedTasks(importId: string): Promise<Array<{ reel_id: number; shortcode: string }>> {
    const { rows } = await this.db.query<{ reel_id: number; shortcode: string }>(
      `UPDATE reel_tasks t SET stage = 'queued', error = NULL, error_kind = NULL, updated_at = now()
       FROM reels r WHERE t.reel_id = r.id AND t.import_job_id = $1
         AND (t.stage = 'failed' OR (t.stage = 'skipped' AND t.error_kind IN ('unavailable', 'cancelled')))
       RETURNING t.reel_id, r.shortcode`,
      [importId],
    );
    return rows;
  }

  /** pg-boss jobs of this import that have not finished yet. */
  async pendingQueueJobs(importId: string): Promise<Array<{ id: string; name: string }>> {
    const { rows } = await this.db.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM pgboss.job WHERE data->>'importId' = $1 AND state IN ('created', 'retry', 'active')`,
      [importId],
    );
    return rows;
  }

  async cancelUnfinishedTasks(importId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE reel_tasks SET stage = 'skipped', error_kind = 'cancelled', error = 'Stopped by user', updated_at = now()
       WHERE import_job_id = $1 AND stage NOT IN ${TERMINAL_STAGES}`,
      [importId],
    );
    return res.rowCount ?? 0;
  }

  async pendingTaskCount(importId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reel_tasks WHERE import_job_id = $1 AND stage NOT IN ${TERMINAL_STAGES}`,
      [importId],
    );
    return rows[0]!.n;
  }

  async getAudioAsset(reelId: number): Promise<{ sha256: string; path: string; duration_seconds: number | null } | null> {
    const { rows } = await this.db.query(`SELECT sha256, path, duration_seconds FROM audio_assets WHERE reel_id = $1`, [reelId]);
    return rows[0] ?? null;
  }

  async saveAudioAsset(a: { reelId: number; provider: string; sha256: string; path: string; durationSeconds: number | null; bytes: number }): Promise<void> {
    await this.db.query(
      `INSERT INTO audio_assets (reel_id, provider, sha256, path, duration_seconds, bytes) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (reel_id) DO UPDATE SET provider = EXCLUDED.provider, sha256 = EXCLUDED.sha256, path = EXCLUDED.path,
         duration_seconds = EXCLUDED.duration_seconds, bytes = EXCLUDED.bytes, created_at = now()`,
      [a.reelId, a.provider, a.sha256, a.path, a.durationSeconds, a.bytes],
    );
  }

  async getCachedTranscript(sha256: string, provider: string, model: string): Promise<{ id: number; status: string } | null> {
    const { rows } = await this.db.query(
      `SELECT id, status FROM transcripts WHERE audio_sha256 = $1 AND provider = $2 AND model = $3 AND status IN ('completed','no_speech')`,
      [sha256, provider, model],
    );
    return rows[0] ?? null;
  }

  async saveTranscript(t: { sha256: string; provider: string; model: string; processingMs: number } & (
    | { result: TranscriptionResult }
    | { error: string }
  )): Promise<void> {
    const ok = 'result' in t;
    await this.db.query(
      `INSERT INTO transcripts (audio_sha256, provider, model, status, language, language_probability, text, segments, error, processing_ms, cost_usd, text_en, segments_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (audio_sha256, provider, model) DO UPDATE SET status = EXCLUDED.status, language = EXCLUDED.language,
         language_probability = EXCLUDED.language_probability, text = EXCLUDED.text, segments = EXCLUDED.segments,
         error = EXCLUDED.error, processing_ms = EXCLUDED.processing_ms, text_en = EXCLUDED.text_en, segments_en = EXCLUDED.segments_en, cost_usd = transcripts.cost_usd + EXCLUDED.cost_usd, created_at = now()`,
      [
        t.sha256, t.provider, t.model,
        ok ? t.result.status : 'failed',
        ok ? t.result.language : null,
        ok ? t.result.languageProbability : null,
        ok ? t.result.text : null,
        ok ? JSON.stringify(t.result.segments) : null,
        ok ? null : t.error,
        t.processingMs,
        ok ? t.result.costUsd : 0,
        ok ? (t.result.english?.text ?? null) : null,
        ok && t.result.english ? JSON.stringify(t.result.english.segments) : null,
      ],
    );
  }

  async recordCost(importId: string | null, reelId: number | null, c: CostEntry, cached = false): Promise<void> {
    await this.db.query(
      `INSERT INTO cost_events (import_job_id, reel_id, provider, operation, units, unit, cost_usd, cached) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [importId, reelId, c.provider, c.operation, c.units, c.unit, c.costUsd, cached],
    );
  }

  async importSummary(id: string) {
    const job = await this.getImport(id);
    if (!job) return null;
    const [stages, failures, costs, profile, tasks] = await Promise.all([
      this.db.query<{ stage: TaskStage; n: number }>(`SELECT stage, count(*)::int AS n FROM reel_tasks WHERE import_job_id = $1 GROUP BY stage`, [id]),
      this.db.query<{ shortcode: string; stage: TaskStage; error_kind: string; error: string; attempts: number }>(
        `SELECT r.shortcode, t.stage, t.error_kind, t.error, t.attempts FROM reel_tasks t JOIN reels r ON r.id = t.reel_id
         WHERE t.import_job_id = $1 AND t.stage IN ('failed','skipped') ORDER BY r.shortcode LIMIT 200`,
        [id],
      ),
      this.db.query<{ provider: string; operation: string; units: number; unit: string; cost_usd: number; cached_units: number }>(
        `SELECT provider, operation, sum(units)::float AS units, unit, sum(cost_usd)::float AS cost_usd,
                sum(CASE WHEN cached THEN units ELSE 0 END)::float AS cached_units
         FROM cost_events WHERE import_job_id = $1 GROUP BY provider, operation, unit ORDER BY provider`,
        [id],
      ),
      job.profile_id ? this.db.query<{ username: string; reported_media_count: number | null }>(`SELECT username, reported_media_count FROM profiles WHERE id = $1`, [job.profile_id]) : null,
      this.db.query<{ shortcode: string; owner: string | null; stage: TaskStage; attempts: number; fetch_ms: number | null; transcribe_ms: number | null; transcript_cached: boolean | null; duration_seconds: number | null; transcribing_for_ms: number | null; note: string | null; views: number | null; error_kind: string | null }>(
        `SELECT r.shortcode, COALESCE(p.username, r.owner_username) AS owner, t.stage, t.error_kind, CASE WHEN t.stage = 'done' THEN t.error END AS note,
                (SELECT COALESCE(m.views, m.plays) FROM metric_snapshots m WHERE m.reel_id = r.id AND COALESCE(m.views, m.plays) IS NOT NULL
                 ORDER BY m.approximate ASC, m.collected_at DESC LIMIT 1) AS views, t.attempts, t.fetch_ms, t.transcribe_ms, t.transcript_cached, r.duration_seconds::float AS duration_seconds,
                CASE WHEN t.stage = 'transcribing' THEN (extract(epoch FROM now() - t.transcribe_started_at) * 1000)::int END AS transcribing_for_ms
         FROM reel_tasks t JOIN reels r ON r.id = t.reel_id LEFT JOIN profiles p ON p.id = r.profile_id
         WHERE t.import_job_id = $1 ORDER BY r.published_at DESC NULLS LAST, r.shortcode LIMIT 1000`,
        [id],
      ),
    ]);
    return { job, stages: Object.fromEntries(stages.rows.map((r) => [r.stage, r.n])) as Partial<Record<TaskStage, number>>, failures: failures.rows, costs: costs.rows, profile: profile?.rows[0] ?? null, tasks: tasks.rows };
  }

  /** Creators with at least one reel, for the Library. */
  async listProfiles() {
    const { rows } = await this.db.query<{ username: string; reels: number; transcribed: number; top_views: number | null; median_likes: number | null; last_seen: Date | null }>(
      `SELECT p.username, count(r.id)::int AS reels,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM audio_assets a JOIN transcripts t ON t.audio_sha256 = a.sha256 AND t.status = 'completed' WHERE a.reel_id = r.id))::int AS transcribed,
              max(v.views) AS top_views,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.likes))::float AS median_likes,
              max(r.last_seen_at) AS last_seen
       FROM profiles p JOIN reels r ON r.profile_id = p.id
       LEFT JOIN LATERAL (SELECT COALESCE(views, plays) AS views FROM metric_snapshots WHERE reel_id = r.id AND COALESCE(views, plays) IS NOT NULL ORDER BY approximate ASC, collected_at DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT likes FROM metric_snapshots WHERE reel_id = r.id AND likes IS NOT NULL ORDER BY approximate ASC, collected_at DESC LIMIT 1) l ON true
       GROUP BY p.username ORDER BY max(r.last_seen_at) DESC NULLS LAST`,
    );
    return rows;
  }

  async listImports(limit: number) {
    const { rows } = await this.db.query<{
      id: string; status: ImportStatus; created_at: Date; finished_at: Date | null; reels_discovered: number; error: string | null;
      done: number; skipped: number; failed: number; owners: string[];
    }>(
      `SELECT j.id, j.status, j.created_at, j.finished_at, j.reels_discovered, j.error,
              count(*) FILTER (WHERE t.stage = 'done')::int AS done,
              count(*) FILTER (WHERE t.stage = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE t.stage = 'failed')::int AS failed,
              COALESCE(array_agg(DISTINCT COALESCE(p.username, r.owner_username)) FILTER (WHERE COALESCE(p.username, r.owner_username) IS NOT NULL), '{}') AS owners
       FROM import_jobs j
       LEFT JOIN reel_tasks t ON t.import_job_id = j.id
       LEFT JOIN reels r ON r.id = t.reel_id
       LEFT JOIN profiles p ON p.id = r.profile_id
       GROUP BY j.id ORDER BY j.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /**
   * Delete reels and everything derived from them. Transcripts are shared by
   * audio hash, so they are only removed when no remaining reel uses that audio.
   * Returns audio file paths for the caller to remove from disk.
   */
  async deleteReels(reelIds: number[]): Promise<{ deleted: number; audioPaths: string[] }> {
    if (!reelIds.length) return { deleted: 0, audioPaths: [] };
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: audio } = await client.query<{ path: string; sha256: string }>(`SELECT path, sha256 FROM audio_assets WHERE reel_id = ANY($1)`, [reelIds]);
      const res = await client.query(`DELETE FROM reels WHERE id = ANY($1)`, [reelIds]);
      await client.query(
        `DELETE FROM transcripts t WHERE t.audio_sha256 = ANY($1) AND NOT EXISTS (SELECT 1 FROM audio_assets a WHERE a.sha256 = t.audio_sha256)`,
        [audio.map((a) => a.sha256)],
      );
      await client.query('COMMIT');
      return { deleted: res.rowCount ?? 0, audioPaths: audio.map((a) => a.path) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Best known view count: exact values win over rounded grid values, newest first. */
  async bestViews(reelId: number): Promise<number | null> {
    const { rows } = await this.db.query<{ v: number }>(
      `SELECT COALESCE(views, plays) AS v FROM metric_snapshots WHERE reel_id = $1 AND COALESCE(views, plays) IS NOT NULL
       ORDER BY approximate ASC, collected_at DESC LIMIT 1`,
      [reelId],
    );
    return rows[0]?.v ?? null;
  }

  async reelIdsByShortcodes(shortcodes: string[]): Promise<number[]> {
    const { rows } = await this.db.query<{ id: number }>(`SELECT id FROM reels WHERE shortcode = ANY($1)`, [shortcodes]);
    return rows.map((r) => r.id);
  }

  /** Delete transcripts (all models) for these reels' audio; the audio is kept so they can be re-transcribed. */
  async deleteTranscriptsForReels(reelIds: number[]): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM transcripts WHERE audio_sha256 IN (SELECT sha256 FROM audio_assets WHERE reel_id = ANY($1))`,
      [reelIds],
    );
    return res.rowCount ?? 0;
  }

  async reelIdByShortcode(shortcode: string): Promise<number | null> {
    const { rows } = await this.db.query<{ id: number }>(`SELECT id FROM reels WHERE shortcode = $1`, [shortcode]);
    return rows[0]?.id ?? null;
  }

  /** Reels that belong only to this import (not shared with another import). */
  async reelsOnlyInImport(importId: string): Promise<number[]> {
    const { rows } = await this.db.query<{ reel_id: number }>(
      `SELECT t.reel_id FROM reel_tasks t WHERE t.import_job_id = $1
         AND NOT EXISTS (SELECT 1 FROM reel_tasks o WHERE o.reel_id = t.reel_id AND o.import_job_id <> $1)`,
      [importId],
    );
    return rows.map((r) => r.reel_id);
  }

  async deleteImport(importId: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM import_jobs WHERE id = $1`, [importId]);
    return (res.rowCount ?? 0) > 0;
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const { rows } = await this.db.query<{ value: T }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  /** Reels with the latest *non-null* value per metric, its age, and the transcript. */
  async reelsForProfile(username: string, staleAfterHours: number): Promise<ReelView[]> {
    const { rows } = await this.db.query<ReelView>(
      `SELECT r.id, r.shortcode, r.url, r.caption, r.published_at, r.duration_seconds::float AS duration_seconds, r.availability,
              mv.views, mv.views_at, mv.views_approx, mp.plays, mp.plays_at, ml.likes, ml.likes_at, ml.likes_approx, mc.comments, mc.comments_at, mc.comments_approx,
              (SELECT bool_or(metrics_hidden) FROM metric_snapshots WHERE reel_id = r.id) AS metrics_hidden,
              t.status AS transcript_status, t.language, t.text AS transcript, t.segments, t.text_en AS transcript_en, t.segments_en, t.provider AS transcript_provider, t.model AS transcript_model,
              ARRAY(SELECT x FROM unnest(ARRAY[
                CASE WHEN mv.views IS NULL AND mp.plays IS NULL THEN 'views' END,
                CASE WHEN ml.likes IS NULL THEN 'likes' END,
                CASE WHEN mc.comments IS NULL THEN 'comments' END]) x WHERE x IS NOT NULL) AS missing_metrics,
              ARRAY(SELECT x FROM unnest(ARRAY[
                CASE WHEN mv.views_at < now() - make_interval(hours => $2) THEN 'views' END,
                CASE WHEN ml.likes_at < now() - make_interval(hours => $2) THEN 'likes' END,
                CASE WHEN mc.comments_at < now() - make_interval(hours => $2) THEN 'comments' END]) x WHERE x IS NOT NULL) AS stale_metrics
       FROM reels r
       JOIN profiles p ON p.id = r.profile_id
       LEFT JOIN LATERAL (SELECT views, collected_at AS views_at, approximate AS views_approx FROM metric_snapshots WHERE reel_id = r.id AND views IS NOT NULL ORDER BY approximate ASC, collected_at DESC LIMIT 1) mv ON true
       LEFT JOIN LATERAL (SELECT plays, collected_at AS plays_at FROM metric_snapshots WHERE reel_id = r.id AND plays IS NOT NULL ORDER BY collected_at DESC LIMIT 1) mp ON true
       LEFT JOIN LATERAL (SELECT likes, collected_at AS likes_at, approximate AS likes_approx FROM metric_snapshots WHERE reel_id = r.id AND likes IS NOT NULL ORDER BY approximate ASC, collected_at DESC LIMIT 1) ml ON true
       LEFT JOIN LATERAL (SELECT comments, collected_at AS comments_at, approximate AS comments_approx FROM metric_snapshots WHERE reel_id = r.id AND comments IS NOT NULL ORDER BY approximate ASC, collected_at DESC LIMIT 1) mc ON true
       LEFT JOIN audio_assets a ON a.reel_id = r.id
       LEFT JOIN LATERAL (SELECT * FROM transcripts WHERE audio_sha256 = a.sha256 ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1) t ON true
       WHERE p.username = $1
       ORDER BY r.published_at DESC NULLS LAST`,
      [username, staleAfterHours],
    );
    return rows;
  }
}

export interface ReelView {
  id: number;
  shortcode: string;
  url: string;
  caption: string | null;
  published_at: Date | null;
  duration_seconds: number | null;
  availability: string;
  views: number | null;
  views_at: Date | null;
  views_approx: boolean | null;
  likes_approx: boolean | null;
  comments_approx: boolean | null;
  plays: number | null;
  plays_at: Date | null;
  likes: number | null;
  likes_at: Date | null;
  comments: number | null;
  comments_at: Date | null;
  metrics_hidden: boolean | null;
  transcript_status: string | null;
  language: string | null;
  transcript: string | null;
  segments: TranscriptSegment[] | null;
  transcript_en: string | null;
  segments_en: TranscriptSegment[] | null;
  transcript_provider: string | null;
  transcript_model: string | null;
  missing_metrics: string[];
  stale_metrics: string[];
}

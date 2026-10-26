import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { InputError, type ReelIngest } from '../module.js';

const importBody = z
  .object({
    profileUrl: z.string().min(1).optional(),
    reelUrls: z.array(z.string().min(1)).max(1000).optional(),
    maxReels: z.number().int().min(1).max(5000).optional(),
    transcribe: z.boolean().optional(),
    transcribeMinViews: z.number().int().min(0).optional(),
    observedMetrics: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{5,64}$/),
        z.object({ views: z.number().int().min(0).nullable().optional(), likes: z.number().int().min(0).nullable().optional(), comments: z.number().int().min(0).nullable().optional() }),
      )
      .optional(),
  })
  .refine((b) => b.profileUrl || b.reelUrls?.length, { message: 'profileUrl or reelUrls is required' });

const uuid = z.object({ id: z.string().uuid() });
const username = z.object({ username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/) });

export function buildServer(ingest: ReelIngest) {
  const app = Fastify({ loggerInstance: ingest.log });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', issues: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    if (err instanceof InputError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    // Fastify's own client errors (bad JSON, empty body, ...) keep their status and message.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request', message: (err as Error).message });
    ingest.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // Minimal local UI; resolves from both src/api (tsx) and dist/api (build).
  const uiPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html');
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(await readFile(uiPath, 'utf8')));

  app.get('/v1/capabilities', async () => ({
    discoveryProvider: ingest.providers.discovery?.name ?? null,
    mediaProvider: ingest.providers.media.name,
    transcription: `${ingest.providers.transcription.name}/${ingest.providers.transcription.model}`,
  }));

  app.get('/healthz', async () => {
    await ingest.db.query('SELECT 1');
    return { ok: true };
  });

  /** Start (or join an in-flight) import. Returns immediately; work runs in background jobs. */
  app.post('/v1/imports', async (req, reply) => {
    const body = importBody.parse(req.body);
    const res = await ingest.importProfile(body);
    return reply.code(res.deduplicated ? 200 : 202).send({ ...res, statusUrl: `/v1/imports/${res.importId}` });
  });

  app.get('/v1/imports/:id', async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const status = await ingest.getImportStatus(id);
    return status ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/v1/imports', async () => ({ imports: await ingest.listImports(30) }));

  /** Stop a running import (kills in-flight downloads/transcriptions). Resume with /retry. */
  app.post('/v1/imports/:id/cancel', async (req, reply) => {
    const { id } = uuid.parse(req.params);
    if (!(await ingest.repo.getImport(id))) return reply.code(404).send({ error: 'not_found' });
    const res = await ingest.cancelImport(id);
    if (res.notRunning) return reply.code(409).send({ error: 'not_running', message: 'This import is not running.' });
    return res;
  });

  /** Change the view threshold of an import (also while it runs). */
  app.patch('/v1/imports/:id', async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const { transcribeMinViews } = z.object({ transcribeMinViews: z.number().int().min(0).nullable() }).parse(req.body);
    if (!(await ingest.setImportMinViews(id, transcribeMinViews))) return reply.code(404).send({ error: 'not_found' });
    return ingest.getImportStatus(id);
  });

  app.delete('/v1/imports/:id', async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const withReels = z.object({ withReels: z.enum(['true', 'false']).optional() }).parse(req.query).withReels === 'true';
    const res = await ingest.deleteImport(id, { withReels });
    if (res.running) return reply.code(409).send({ error: 'import_running', message: 'Wait for the import to finish before deleting it.' });
    return res.deleted ? res : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/v1/reels/:shortcode', async (req, reply) => {
    const { shortcode } = z.object({ shortcode: z.string().regex(/^[A-Za-z0-9_-]{5,64}$/) }).parse(req.params);
    return (await ingest.deleteReel(shortcode)) ? { deleted: true } : reply.code(404).send({ error: 'not_found' });
  });

  const shortcodeList = z.object({ shortcodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{5,64}$/)).min(1).max(5000) });

  /** Bulk delete reels (with metrics, transcripts and audio files). */
  app.post('/v1/reels/delete', async (req) => ingest.deleteReels(shortcodeList.parse(req.body).shortcodes));

  /** Bulk delete transcripts only; reels, metrics and audio stay, so they can be re-transcribed. */
  app.post('/v1/reels/delete-transcripts', async (req) => ingest.deleteTranscripts(shortcodeList.parse(req.body).shortcodes));

  app.get('/v1/settings', async () => ingest.getSettings());
  app.put('/v1/settings', async (req) => {
    const body = z
      .object({
        transcriptionMode: z.enum(['sequential', 'parallel']).optional(),
        transcriptionConcurrency: z.number().int().min(1).max(64).optional(),
      })
      .parse(req.body);
    return ingest.updateSettings(body);
  });

  /** Re-queue failed (and logged-out-unavailable) reels, or re-run a failed discovery. Never duplicates records. */
  app.post('/v1/imports/:id/retry', async (req, reply) => {
    const { id } = uuid.parse(req.params);
    if (!(await ingest.repo.getImport(id))) return reply.code(404).send({ error: 'not_found' });
    return ingest.retryImport(id);
  });

  app.get('/v1/profiles', async () => ({ profiles: await ingest.listProfiles() }));

  /** Reels + latest metrics + transcripts: the input contract for script generation. */
  app.get('/v1/profiles/:username/reels', async (req) => {
    const { username: u } = username.parse(req.params);
    const reels = await ingest.getReels(u);
    return {
      username: u.toLowerCase(),
      count: reels.length,
      reels: reels.map((r) => ({
        shortcode: r.shortcode,
        url: r.url,
        caption: r.caption,
        publishedAt: r.published_at,
        durationSeconds: r.duration_seconds,
        availability: r.availability,
        metrics: {
          views: r.views ?? r.plays,
          likes: r.likes,
          comments: r.comments,
          // true when the value is a rounded number read from Instagram's profile grid (e.g. "1.4m").
          approximate: { views: Boolean(r.views_approx), likes: Boolean(r.likes_approx), comments: Boolean(r.comments_approx) },
          collectedAt: { views: r.views_at ?? r.plays_at, likes: r.likes_at, comments: r.comments_at },
          hidden: r.metrics_hidden,
          missing: r.missing_metrics,
          stale: r.stale_metrics,
        },
        transcript: r.transcript_status
          ? {
              status: r.transcript_status,
              language: r.language,
              // English: the original if already English, otherwise Whisper's translation. Null if not produced.
              english: r.transcript_en !== null ? { text: r.transcript_en, segments: r.segments_en } : r.language === 'en' ? { text: r.transcript, segments: r.segments } : null,
              original: { text: r.transcript, segments: r.segments },
              provider: r.transcript_provider,
              model: r.transcript_model,
            }
          : null,
      })),
    };
  });

  app.get('/v1/profiles/:username/analytics', async (req) => {
    const { username: u } = username.parse(req.params);
    return ingest.getReport(u);
  });

  return app;
}

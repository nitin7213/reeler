import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createReelIngest, type ReelIngest } from '../src/module.js';
import { ProviderError, type ReelMediaProvider, type TranscriptionProvider } from '../src/providers/types.js';
import { CancelledError, run } from '../src/util/exec.js';

/**
 * Runs the real pg-boss pipeline against a throwaway database with fake
 * providers, to test dedup, retries, skip handling, caching and finalization.
 * Requires TEST_DATABASE_URL (see README).
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;

const DATA_DIR = path.resolve('data-test');
let throttledOnce = false;
const fetchCalls: string[] = [];

const media: ReelMediaProvider = {
  name: 'fake_media',
  async fetchReel(shortcode, workDir, { downloadAudio }) {
    fetchCalls.push(shortcode);
    if (shortcode === 'DELETED01') throw new ProviderError('unavailable', 'empty media response', 'fake_media');
    if (shortcode === 'THROTTLE1' && !throttledOnce) {
      throttledOnce = true;
      throw new ProviderError('throttled', 'HTTP 429', 'fake_media');
    }
    let mediaPath: string | null = null;
    if (downloadAudio) {
      // Same tone for two reels -> identical audio -> one transcription (cache).
      const hz = ({ REEL00001: 300, DUPAUDIO2: 300, THROTTLE1: 500 } as Record<string, number>)[shortcode] ?? 700;
      mediaPath = path.join(workDir, `${shortcode}.wav`);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, mediaPath]);
    }
    return {
      record: { shortcode, url: `https://www.instagram.com/reel/${shortcode}/`, ownerUsername: 'testcreator', publishedAt: new Date('2026-01-01'), metrics: { views: null, plays: null, likes: 42, comments: 0, metricsHidden: null } },
      mediaPath,
      cost: [],
    };
  },
};

let transcribeCalls = 0;
const stt: TranscriptionProvider = {
  name: 'fake_stt',
  model: 'fake-1',
  async transcribe(_wav, duration) {
    transcribeCalls++;
    return { status: 'completed', language: 'hi', languageProbability: 0.9, text: 'Doston, kya aap jaante ho?', segments: [{ start: 0, end: duration, text: 'Doston, kya aap jaante ho?' }], english: { text: 'Friends, do you know?', segments: [{ start: 0, end: duration, text: 'Friends, do you know?' }] }, costUsd: 0.001 };
  },
};

async function waitFor(ingest: ReelIngest, id: string, done: (s: string) => boolean, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const s = await ingest.getImportStatus(id);
    if (s && done(s.status)) return s;
    if (Date.now() > until) throw new Error(`timeout; last status ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite('pipeline (postgres + pg-boss)', () => {
  let ingest: ReelIngest;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DB });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;');
    await admin.end();
    const cfg = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, DATA_DIR, LOG_LEVEL: 'warn', DISCOVERY_PROVIDER: 'none', RETRY_DELAY_SECONDS: '1' });
    ingest = createReelIngest(cfg, { providers: { discovery: null, media, transcription: stt } });
    await ingest.start();
    await writeFile(path.join(DATA_DIR, '.keep'), '').catch(() => undefined);
  }, 60_000);

  afterAll(async () => {
    await ingest?.stop();
  });

  it('imports reel URLs end to end with retry, skip, dedup and transcript cache', async () => {
    const urls = ['REEL00001', 'DUPAUDIO2', 'DELETED01', 'THROTTLE1'].map((s) => `https://www.instagram.com/reel/${s}/`);
    const first = await ingest.importProfile({ reelUrls: [...urls, urls[0]!] });
    expect(first.deduplicated).toBe(false);

    // Same request while in flight joins the existing import.
    const again = await ingest.importProfile({ reelUrls: urls });
    expect(again).toMatchObject({ importId: first.importId, deduplicated: true });

    const s = await waitFor(ingest, first.importId, (st) => ['completed', 'partial', 'failed'].includes(st), 90_000);
    expect(s.status).toBe('partial'); // one reel is unavailable -> never "completed"
    expect(s.collection).toMatchObject({ reelsDiscovered: 4, coverage: 'user_supplied' });
    expect(s.progress).toMatchObject({ total: 4, done: 3, skipped: 1, percent: 100 });
    expect(s.failures).toEqual([expect.objectContaining({ shortcode: 'DELETED01', outcome: 'skipped', kind: 'unavailable' })]);
    expect(fetchCalls.filter((c) => c === 'THROTTLE1')).toHaveLength(2); // retried after 429
    expect(transcribeCalls).toBe(2); // DUPAUDIO2 reused REEL00001's transcript
    const stt = s.costs.items.find((c) => c.provider === 'fake_stt')!;
    expect(stt.cachedUnits).toBeGreaterThan(0);

    const reels = await ingest.getReels('testcreator');
    // DELETED01 was never fetched, so it has no known owner and is not linked to the profile.
    expect(reels.map((r) => r.shortcode).sort()).toEqual(['DUPAUDIO2', 'REEL00001', 'THROTTLE1']);
    const r1 = reels.find((r) => r.shortcode === 'REEL00001')!;
    expect(r1).toMatchObject({ likes: 42, comments: 0, views: null, transcript_status: 'completed', language: 'hi' });
    expect(r1.missing_metrics).toEqual(['views']);
    expect(r1.duration_seconds).toBeCloseTo(2, 0);
    expect(r1.transcript_en).toBe('Friends, do you know?');

    // Status exposes timing and a per-reel list with owners, so the UI can link to results.
    expect(s.timing).toMatchObject({ basis: 'done', secondsRemaining: 0 });
    expect(s.reels.find((x) => x.shortcode === 'REEL00001')).toMatchObject({ owner: 'testcreator', stage: 'done', transcriptFromCache: false });
    expect(s.reels.find((x) => x.shortcode === 'DUPAUDIO2')!.transcriptFromCache).toBe(true);
    expect(s.reels.find((x) => x.shortcode === 'REEL00001')!.downloadSeconds).not.toBeNull();
  }, 120_000);

  it('retry re-queues only unfinished reels without duplicating rows', async () => {
    const { rows: before } = await ingest.db.query<{ n: number }>('SELECT count(*)::int AS n FROM reels');
    const imp = (await ingest.db.query<{ id: string }>('SELECT id FROM import_jobs ORDER BY created_at LIMIT 1')).rows[0]!;
    const res = await ingest.retryImport(imp.id);
    expect(res).toEqual({ requeued: 1, rediscover: false }); // only the 'unavailable' reel
    const s = await waitFor(ingest, imp.id, (st) => st === 'partial');
    expect(s.progress.total).toBe(4);
    const { rows: after } = await ingest.db.query<{ n: number }>('SELECT count(*)::int AS n FROM reels');
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 60_000);

  it('profile import without a discovery provider fails with an actionable message', async () => {
    const res = await ingest.importProfile({ profileUrl: 'https://www.instagram.com/testcreator/' });
    const s = await waitFor(ingest, res.importId, (st) => st === 'failed');
    expect(s.error).toMatch(/No discovery provider is configured/);
  }, 30_000);

  it('analytics report separates measured data from hypotheses', async () => {
    const report = await ingest.getReport('testcreator');
    expect(report.measured.primaryMetric).toBe('likes');
    expect(report.measured.dataQuality).toMatchObject({ missingViews: 3, transcribed: 3 });
    expect(report.content[0]!.features.hook.types).toEqual(expect.arrayContaining(['question', 'direct_address']));
    expect(report.disclaimer).toMatch(/not causal/);
  });

  it('transcribes only reels at or above the view threshold, keeping grid views as approximate', async () => {
    const before = transcribeCalls;
    const res = await ingest.importProfile({
      reelUrls: ['https://www.instagram.com/reel/VIEWSHIGH1/', 'https://www.instagram.com/reel/VIEWSLOW01/', 'https://www.instagram.com/reel/VIEWSNONE1/'],
      transcribeMinViews: 500_000,
      observedMetrics: { VIEWSHIGH1: { views: 1_400_000, likes: 43_300, comments: 734 }, VIEWSLOW01: { views: 90_000 } },
    });
    const s = await waitFor(ingest, res.importId, (st) => ['completed', 'partial'].includes(st));
    expect(s.status).toBe('completed');
    expect(transcribeCalls - before).toBe(1);
    expect(s.reels.find((r) => r.shortcode === 'VIEWSLOW01')!.note).toMatch(/90,000 views is below 500,000/);
    expect(s.reels.find((r) => r.shortcode === 'VIEWSNONE1')!.note).toMatch(/view count unknown/);
    const reels = await ingest.getReels('testcreator');
    const high = reels.find((r) => r.shortcode === 'VIEWSHIGH1')!;
    // Views come only from the grid (approximate); likes come exactly from the reel itself (42 from the fake provider).
    expect(high).toMatchObject({ views: 1_400_000, views_approx: true, likes: 42, likes_approx: false, transcript_status: 'completed' });
    expect(reels.find((r) => r.shortcode === 'VIEWSLOW01')!.transcript_status).toBeNull();
  }, 60_000);

  it('stops a running import (killing the in-flight transcription) and resumes it', async () => {
    const slow: TranscriptionProvider = {
      // Different model name so the transcript cache from earlier tests is not hit.
      name: 'fake_stt', model: 'slow-1',
      transcribe: (_wav, _d, signal) => new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ status: 'completed', language: 'en', languageProbability: 1, text: 'hi', segments: [], english: null, costUsd: 0 }), 20_000);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()); });
      }),
    };
    const original = ingest.providers.transcription;
    ingest.providers.transcription = slow;
    try {
      const codes = ['STOPME0001', 'STOPME0002', 'STOPME0003'];
      const res = await ingest.importProfile({ reelUrls: codes.map((c) => `https://www.instagram.com/reel/${c}/`) });
      await waitFor(ingest, res.importId, () => true);
      // Wait until something is being transcribed, then stop.
      for (let i = 0; i < 100; i++) {
        const s = await ingest.getImportStatus(res.importId);
        if (s?.reels.some((r) => r.stage === 'transcribing')) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const t0 = Date.now();
      const stop = await ingest.cancelImport(res.importId);
      expect(stop.stopped).toBeGreaterThan(0);
      const s = await waitFor(ingest, res.importId, (st) => st === 'cancelled');
      await new Promise((r) => setTimeout(r, 500));
      const after = await ingest.getImportStatus(res.importId);
      expect(Date.now() - t0).toBeLessThan(5_000); // did not wait for the 20s transcription
      expect(after!.reels.every((r) => ['skipped', 'done'].includes(r.stage))).toBe(true);
      expect(after!.failures.some((f) => f.kind === 'cancelled')).toBe(true);
      expect(s.status).toBe('cancelled');
      expect((await ingest.cancelImport(res.importId)).notRunning).toBe(true);

      // Resume with the fast transcriber: the stopped reels finish.
      ingest.providers.transcription = original;
      const resumed = await ingest.retryImport(res.importId);
      expect(resumed.requeued).toBeGreaterThan(0);
      const fin = await waitFor(ingest, res.importId, (st) => ['completed', 'partial'].includes(st));
      expect(fin.status).toBe('completed');
    } finally {
      ingest.providers.transcription = original;
    }
  }, 90_000);

  it('switches between sequential and parallel transcription', async () => {
    expect(await ingest.updateSettings({ transcriptionMode: 'sequential' })).toMatchObject({ transcriptionMode: 'sequential', transcriptionConcurrency: 1 });
    expect(await ingest.updateSettings({ transcriptionMode: 'parallel' })).toMatchObject({ transcriptionMode: 'parallel', transcriptionConcurrency: 2 });
    // Local whisper is capped at 4 (one GPU); asking for 40 is clamped, not an error.
    expect(await ingest.updateSettings({ transcriptionConcurrency: 40 })).toMatchObject({ transcriptionConcurrency: 4, maxTranscriptionConcurrency: 4 });
    expect(await ingest.repo.getSetting('transcriptionConcurrency')).toBe(4);
    await ingest.updateSettings({ transcriptionConcurrency: 2 });
  });

  it('deletes a reel but keeps a transcript another reel still uses', async () => {
    const shared = async () => (await ingest.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM transcripts t JOIN audio_assets a ON a.sha256 = t.audio_sha256 JOIN reels r ON r.id = a.reel_id WHERE r.shortcode = 'REEL00001'`)).rows[0]!.n;
    expect(await ingest.deleteReel('DUPAUDIO2')).toBe(true);
    expect(await shared()).toBe(1); // REEL00001 has the same audio, so its transcript stays
    expect(await ingest.deleteReel('DUPAUDIO2')).toBe(false);
    const left = (await ingest.getReels('testcreator')).map((r) => r.shortcode);
    expect(left).not.toContain('DUPAUDIO2');
    expect(left).toEqual(expect.arrayContaining(['REEL00001', 'THROTTLE1', 'VIEWSHIGH1']));
  });

  it('deletes an import with its reels, and lists imports', async () => {
    const list = await ingest.listImports();
    const imports = list.filter((i) => i.owners.includes('testcreator'));
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const total = (await ingest.db.query<{ n: number }>('SELECT count(*)::int AS n FROM reels')).rows[0]!.n;
    let reelsDeleted = 0;
    for (const imp of imports) {
      const res = await ingest.deleteImport(imp.id, { withReels: true });
      expect(res).toMatchObject({ deleted: true });
      reelsDeleted += res.reelsDeleted;
    }
    // Every reel belonged to one of these imports (DELETED01 was never linked to a profile, but still goes).
    expect(reelsDeleted).toBe(total);
    expect(await ingest.getReels('testcreator')).toEqual([]);
    expect((await ingest.db.query('SELECT 1 FROM transcripts')).rowCount).toBe(0);
    expect((await ingest.listImports()).some((i) => imports.some((x) => x.id === i.id))).toBe(false);
  });
});

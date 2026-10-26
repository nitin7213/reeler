import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalReelUrl } from '../../instagram/urls.js';
import { CancelledError, Pacer, run } from '../../util/exec.js';
import { ProviderError, type ReelMediaProvider, type ReelMediaResult, type ReelRecord } from '../types.js';

/**
 * Per-reel metadata + audio via yt-dlp (the engine behind the FluxNote tool).
 * Logged-out only: we never pass cookies. Downloads the audio-only DASH stream
 * when Instagram offers one, so we do not pull the full video.
 */
export class YtDlpMediaProvider implements ReelMediaProvider {
  readonly name = 'yt_dlp';
  private readonly pacer: Pacer;

  constructor(private readonly opts: { bin: string; minIntervalMs: number; timeoutMs?: number }) {
    this.pacer = new Pacer(opts.minIntervalMs);
  }

  async fetchReel(shortcode: string, workDir: string, { downloadAudio, signal }: { downloadAudio: boolean; signal?: AbortSignal }): Promise<ReelMediaResult> {
    await this.pacer.wait();
    const url = canonicalReelUrl(shortcode);
    const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '30', '--retries', '2'];
    if (downloadAudio) {
      args.push(
        '-f', 'bestaudio[vcodec=none]/best',
        '--write-info-json', '-P', workDir, '-o', '%(id)s.%(ext)s',
        '--print', 'after_move:filepath', '--no-simulate',
      );
    } else {
      args.push('-J');
    }
    args.push('--', url);

    let res;
    try {
      res = await run(this.opts.bin, args, { timeoutMs: this.opts.timeoutMs ?? 180_000, signal });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw new ProviderError('config', `cannot run ${this.opts.bin}: ${(err as Error).message}`, this.name);
    }
    if (res.code !== 0 || /^ERROR:/m.test(res.stderr)) throw classifyYtDlpError(res.stderr || res.stdout, this.name);

    let info: YtDlpInfo;
    let mediaPath: string | null = null;
    if (downloadAudio) {
      mediaPath = res.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
      const infoPath = path.join(workDir, `${shortcode}.info.json`);
      info = JSON.parse(await readFile(infoPath, 'utf8')) as YtDlpInfo;
      await rm(infoPath, { force: true });
    } else {
      info = JSON.parse(res.stdout) as YtDlpInfo;
    }
    return { record: mapYtDlpInfo(info, shortcode), mediaPath, cost: [] };
  }
}

export interface YtDlpInfo {
  id?: string;
  channel?: string;
  uploader_id?: string;
  description?: string | null;
  timestamp?: number | null;
  duration?: number | null;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  formats?: Array<{ acodec?: string | null; vcodec?: string | null }>;
}

export function mapYtDlpInfo(info: YtDlpInfo, shortcode: string): ReelRecord {
  const hasAudio = info.formats?.some((f) => f.acodec && f.acodec !== 'none') ?? null;
  return {
    shortcode,
    url: canonicalReelUrl(shortcode),
    platformMediaId: null,
    ownerUsername: info.channel?.toLowerCase() ?? null,
    caption: info.description ?? null,
    publishedAt: info.timestamp ? new Date(info.timestamp * 1000) : null,
    durationSeconds: info.duration ?? null,
    hasAudio,
    metrics: {
      // yt-dlp's logged-out Instagram extractor does not get play counts (verified 2026-10).
      views: info.view_count ?? null,
      plays: null,
      likes: info.like_count ?? null,
      comments: info.comment_count ?? null,
      metricsHidden: null,
    },
  };
}

export function classifyYtDlpError(stderr: string, provider: string): ProviderError {
  const msg = (stderr.match(/^ERROR:.*$/m)?.[0] ?? stderr).slice(0, 500);
  const s = stderr.toLowerCase();
  if (s.includes('429') || s.includes('rate-limit') || s.includes('too many requests') || s.includes('please wait'))
    return new ProviderError('throttled', msg, provider);
  if (s.includes('private')) return new ProviderError('private', msg, provider);
  if (s.includes('404') || s.includes('not found') || s.includes('has been removed')) return new ProviderError('not_found', msg, provider);
  if (s.includes('empty media response')) return new ProviderError('unavailable', msg, provider);
  if (s.includes('login required') || s.includes('cookies')) return new ProviderError('login_required', msg, provider);
  if (s.includes('timed out') || s.includes('connection') || s.includes('5xx') || /http error 5\d\d/.test(s))
    return new ProviderError('transient', msg, provider);
  return new ProviderError('unknown', msg, provider);
}

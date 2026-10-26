import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalReelUrl } from '../../instagram/urls.js';
import { runApifyActor } from '../apify.js';
import { ProviderError, type ReelMediaProvider, type ReelMediaResult } from '../types.js';

interface ApifyAudioRow {
  url?: string;
  shortCode?: string;
  audioUrl?: string | null;
  audioContainer?: string | null;
  error?: string | null;
}

/**
 * Hosted fallback: maximedupre/instagram-reels-audio-downloader.
 * Single-reel only (no metadata/metrics, no profile discovery), so it only
 * contributes audio. Requires APIFY_TOKEN; pay-per-event pricing.
 */
export class ApifyAudioProvider implements ReelMediaProvider {
  readonly name = 'apify_audio';

  constructor(private readonly opts: { token: string; actor: string; usdPer1000: number }) {}

  async fetchReel(shortcode: string, workDir: string, { downloadAudio, signal }: { downloadAudio: boolean; signal?: AbortSignal }): Promise<ReelMediaResult> {
    const url = canonicalReelUrl(shortcode);
    const rows = await runApifyActor<ApifyAudioRow>(this.opts.token, this.opts.actor, { reelUrls: [{ url }] }, this.name);
    const row = rows[0];
    const cost = [{ provider: this.name, operation: 'audio' as const, units: rows.length, unit: 'results' as const, costUsd: (rows.length * this.opts.usdPer1000) / 1000 }];
    if (!row?.audioUrl) throw new ProviderError('unavailable', row?.error ?? 'no audio returned for reel', this.name);

    let mediaPath: string | null = null;
    if (downloadAudio) {
      const res = await fetch(row.audioUrl, { signal });
      if (!res.ok) throw new ProviderError(res.status === 429 ? 'throttled' : 'transient', `audio download HTTP ${res.status}`, this.name);
      mediaPath = path.join(workDir, `${shortcode}.${row.audioContainer || 'm4a'}`);
      await writeFile(mediaPath, Buffer.from(await res.arrayBuffer()));
    }
    return {
      record: { shortcode, url, metrics: { views: null, plays: null, likes: null, comments: null, metricsHidden: null } },
      mediaPath,
      cost,
    };
  }
}

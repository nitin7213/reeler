import { canonicalReelUrl } from '../../instagram/urls.js';
import { runApifyActor } from '../apify.js';
import { ProviderError, type CostEntry, type DiscoveryPage, type DiscoveryProvider, type ProfileInfo, type ReelRecord } from '../types.js';

interface ApifyReelRow {
  shortCode?: string;
  url?: string;
  id?: string;
  ownerUsername?: string;
  caption?: string;
  timestamp?: string;
  videoDuration?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  likesCount?: number;
  commentsCount?: number;
  productType?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Paid, hosted profile-wide discovery via apify/instagram-reel-scraper.
 * Opt-in only (DISCOVERY_PROVIDER=apify_reel_scraper + APIFY_TOKEN). The
 * actor runs on Apify's infrastructure; review Apify's and Instagram's terms
 * before enabling. One run returns up to `limit` reels, so there is no cursor.
 */
export class ApifyReelScraperProvider implements DiscoveryProvider {
  readonly name = 'apify_reel_scraper';
  readonly maxReachableNote = 'Apify does not report the total number of Reels on a profile, so completeness cannot be verified.';

  constructor(private readonly opts: { token: string; actor: string; usdPer1000: number }) {}

  async getProfile(username: string): Promise<ProfileInfo> {
    // The reel scraper has no profile endpoint; details come from reel rows.
    return { username, reportedMediaCount: null };
  }

  async listReels(username: string, _cursor: string | null, { limit }: { limit: number }): Promise<DiscoveryPage & { cost: CostEntry[]; scannedMedia: number }> {
    const rows = await runApifyActor<ApifyReelRow>(this.opts.token, this.opts.actor, { username: [username], resultsLimit: limit }, this.name, 600);
    const failure = rows.find((r) => r.error);
    if (failure && rows.every((r) => r.error)) {
      const text = `${failure.error} ${failure.errorDescription ?? ''}`.trim();
      throw new ProviderError(/private/i.test(text) ? 'private' : /not.?found|does not exist/i.test(text) ? 'not_found' : 'unknown', text, this.name);
    }
    const reels = rows.filter((r) => !r.error).map(mapApifyReel).filter((r): r is ReelRecord => r !== null);
    return {
      reels,
      nextCursor: null,
      scannedMedia: rows.length,
      cost: [{ provider: this.name, operation: 'discovery', units: rows.length, unit: 'results', costUsd: (rows.length * this.opts.usdPer1000) / 1000 }],
    };
  }
}

const nonNegative = (n: number | undefined) => (typeof n === 'number' && n >= 0 ? n : null);

export function mapApifyReel(r: ApifyReelRow): ReelRecord | null {
  if (!r.shortCode) return null;
  return {
    shortcode: r.shortCode,
    url: canonicalReelUrl(r.shortCode),
    platformMediaId: r.id ?? null,
    ownerUsername: r.ownerUsername?.toLowerCase() ?? null,
    caption: r.caption ?? null,
    publishedAt: r.timestamp ? new Date(r.timestamp) : null,
    durationSeconds: r.videoDuration ?? null,
    metrics: {
      views: nonNegative(r.videoViewCount),
      plays: nonNegative(r.videoPlayCount),
      // Apify reports -1 when the owner hides like counts.
      likes: nonNegative(r.likesCount),
      comments: nonNegative(r.commentsCount),
      metricsHidden: r.likesCount === -1 ? true : null,
    },
  };
}

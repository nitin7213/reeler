import { parseReelShortcode } from '../../instagram/urls.js';
import { Pacer } from '../../util/exec.js';
import { ProviderError, type CostEntry, type DiscoveryPage, type DiscoveryProvider, type ProfileInfo, type ReelRecord } from '../types.js';

const MEDIA_FIELDS = 'id,shortcode,permalink,caption,timestamp,media_type,media_product_type,like_count,comments_count,view_count';

interface GraphMedia {
  id: string;
  shortcode?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  media_type?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
}

interface BusinessDiscovery {
  id: string;
  username: string;
  name?: string;
  media_count?: number;
  media?: { data: GraphMedia[]; paging?: { cursors?: { after?: string }; next?: string } };
}

/**
 * Official, free, profile-wide discovery via the Instagram Graph API
 * `business_discovery` field. Requires YOUR OWN Instagram professional account
 * linked to a Facebook Page, and a token with instagram_basic +
 * pages_read_engagement (+ instagram_manage_insights). Target accounts must be
 * Business or Creator accounts; personal accounts are not visible.
 * Returns views/likes/comments but not video duration.
 */
export class MetaBusinessDiscoveryProvider implements DiscoveryProvider {
  readonly name = 'meta_business_discovery';
  readonly maxReachableNote = 'Only Business/Creator accounts are visible; age-gated accounts are excluded.';
  private readonly pacer = new Pacer(500);

  constructor(private readonly opts: { accessToken: string; igUserId: string; version: string; fetchImpl?: typeof fetch }) {}

  async getProfile(username: string): Promise<ProfileInfo> {
    const bd = await this.query(username, 'id,username,name,media_count');
    return { username: bd.username.toLowerCase(), platformUserId: bd.id, displayName: bd.name ?? null, isPrivate: false, reportedMediaCount: bd.media_count ?? null };
  }

  async listReels(username: string, cursor: string | null, { limit }: { limit: number }): Promise<DiscoveryPage & { cost: CostEntry[]; scannedMedia: number }> {
    const page = Math.min(Math.max(limit, 1), 50);
    const media = `media.limit(${page})${cursor ? `.after(${cursor})` : ''}{${MEDIA_FIELDS}}`;
    const bd = await this.query(username, `id,username,${media}`);
    const items = bd.media?.data ?? [];
    const reels = items.filter((m) => m.media_product_type === 'REELS').map(mapGraphMedia).filter((r): r is ReelRecord => r !== null);
    const after = bd.media?.paging?.cursors?.after;
    return {
      reels,
      // Graph API omits `next` on the last page even when cursors are present.
      nextCursor: bd.media?.paging?.next && after ? after : null,
      scannedMedia: items.length,
      cost: [{ provider: this.name, operation: 'discovery', units: 1, unit: 'requests', costUsd: 0 }],
    };
  }

  private async query(username: string, fields: string): Promise<BusinessDiscovery> {
    await this.pacer.wait();
    const url = new URL(`https://graph.facebook.com/${this.opts.version}/${this.opts.igUserId}`);
    url.searchParams.set('fields', `business_discovery.username(${username}){${fields}}`);
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { authorization: `Bearer ${this.opts.accessToken}` }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new ProviderError('transient', `Graph API request failed: ${(err as Error).message}`, this.name);
    }
    const body = (await res.json().catch(() => ({}))) as { business_discovery?: BusinessDiscovery; error?: GraphError };
    if (body.error || !res.ok) throw classifyGraphError(body.error, res.status, this.name);
    if (!body.business_discovery) throw new ProviderError('not_found', `@${username} not returned by business_discovery`, this.name);
    return body.business_discovery;
  }
}

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
}

export function classifyGraphError(err: GraphError | undefined, status: number, provider: string): ProviderError {
  const msg = err?.message ?? `HTTP ${status}`;
  const code = err?.code;
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return new ProviderError('throttled', msg, provider);
  if (code === 190 || code === 10 || code === 200 || status === 401) return new ProviderError('config', `Meta token/permission problem: ${msg}`, provider);
  // 110 / 100 + subcode 2207013: username is not a Business/Creator account or does not exist.
  if (code === 110 || err?.error_subcode === 2207013 || /cannot be found|does not exist|not a business/i.test(msg))
    return new ProviderError('not_found', `Account not found, or not a Business/Creator account (personal accounts are not visible to business_discovery): ${msg}`, provider);
  if (status >= 500) return new ProviderError('transient', msg, provider);
  return new ProviderError('unknown', msg, provider);
}

export function mapGraphMedia(m: GraphMedia): ReelRecord | null {
  const shortcode = m.shortcode ?? (m.permalink ? parseReelShortcode(m.permalink) : null);
  if (!shortcode) return null;
  return {
    shortcode,
    url: m.permalink ?? `https://www.instagram.com/reel/${shortcode}/`,
    platformMediaId: m.id,
    caption: m.caption ?? null,
    publishedAt: m.timestamp ? new Date(m.timestamp) : null,
    durationSeconds: null,
    metrics: {
      views: m.view_count ?? null,
      plays: null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      // like_count is omitted when the owner hides likes.
      metricsHidden: m.like_count === undefined ? true : null,
    },
  };
}

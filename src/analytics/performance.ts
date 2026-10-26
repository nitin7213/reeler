/**
 * Measured performance only. Nothing here infers *why* a reel performed;
 * see content.ts / report.ts for clearly labelled hypotheses.
 */

export interface PerfInput {
  shortcode: string;
  publishedAt: Date | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export type PrimaryMetric = 'views' | 'likes' | 'engagement';

export interface ReelPerformance {
  shortcode: string;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** likes + comments; null if either is missing. */
  engagement: number | null;
  /** (likes + comments) / views; null without views. */
  engagementRate: number | null;
  primaryValue: number | null;
  /** primaryValue / creator median. */
  ratioToMedian: number | null;
  /** primaryValue / median of reels published within ±windowDays. */
  ratioToPeriodMedian: number | null;
  periodPeers: number;
  isOutlier: boolean;
  ranks: Partial<Record<'views' | 'likes' | 'comments' | 'engagement' | 'engagementRate', number>>;
}

export interface PerformanceSummary {
  primaryMetric: PrimaryMetric | null;
  primaryMetricReason: string;
  sampleSize: number;
  withPrimaryMetric: number;
  medians: Record<'views' | 'likes' | 'comments' | 'engagement' | 'engagementRate', number | null>;
  outlierThreshold: number;
  periodWindowDays: number;
  reels: ReelPerformance[];
  outliers: string[];
  caveats: string[];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const present = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null && Number.isFinite(x));

function rankBy(rows: ReelPerformance[], key: keyof ReelPerformance['ranks']) {
  const sorted = rows.filter((r) => r[key] !== null).sort((a, b) => (b[key] as number) - (a[key] as number));
  sorted.forEach((r, i) => (r.ranks[key] = i + 1));
}

export function analyzePerformance(
  input: PerfInput[],
  opts: { outlierThreshold?: number; periodWindowDays?: number; minSample?: number } = {},
): PerformanceSummary {
  const threshold = opts.outlierThreshold ?? 2;
  const windowDays = opts.periodWindowDays ?? 45;
  const minSample = opts.minSample ?? 5;
  const caveats: string[] = [];

  const rows: ReelPerformance[] = input.map((r) => {
    const engagement = r.likes !== null && r.comments !== null ? r.likes + r.comments : null;
    return {
      shortcode: r.shortcode,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      engagement,
      engagementRate: engagement !== null && r.views ? engagement / r.views : null,
      primaryValue: null,
      ratioToMedian: null,
      ratioToPeriodMedian: null,
      periodPeers: 0,
      isOutlier: false,
      ranks: {},
    };
  });

  // Prefer views (reach) when most reels have them; otherwise fall back and say so.
  const coverage = (k: 'views' | 'likes' | 'engagement') => rows.filter((r) => r[k] !== null).length / Math.max(rows.length, 1);
  let primary: PrimaryMetric | null = null;
  let reason = 'No reel has views, likes or comments available.';
  if (rows.length && coverage('views') >= 0.6) {
    primary = 'views';
    reason = 'Views are available for most reels.';
  } else if (rows.length && coverage('likes') >= 0.6) {
    primary = 'likes';
    reason = 'Views are unavailable for most reels from this data source; likes are used as the success signal.';
    caveats.push('Likes measure approval among people who saw the reel, not reach. Rankings may differ from view-based rankings.');
  } else if (rows.length && coverage('engagement') >= 0.6) {
    primary = 'engagement';
    reason = 'Using likes + comments.';
  }

  for (const r of rows) r.primaryValue = primary ? (r[primary] as number | null) : null;
  const primaryMedian = median(present(rows.map((r) => r.primaryValue)));
  const withPrimary = rows.filter((r) => r.primaryValue !== null);

  if (withPrimary.length < minSample) caveats.push(`Only ${withPrimary.length} reel(s) have the primary metric; outlier detection needs at least ${minSample}.`);

  for (const r of withPrimary) {
    r.ratioToMedian = primaryMedian ? r.primaryValue! / primaryMedian : null;

    if (r.publishedAt) {
      const t = Date.parse(r.publishedAt);
      const peers = withPrimary.filter(
        (p) => p !== r && p.publishedAt && Math.abs(Date.parse(p.publishedAt) - t) <= windowDays * 86_400_000,
      );
      r.periodPeers = peers.length;
      const pm = peers.length >= 3 ? median(peers.map((p) => p.primaryValue!)) : null;
      r.ratioToPeriodMedian = pm ? r.primaryValue! / pm : null;
    }

    // Outlier: well above the creator's overall median, and (when enough
    // nearby reels exist) above its own period too, so a reel isn't flagged
    // only because the account grew.
    const overall = r.ratioToMedian !== null && r.ratioToMedian >= threshold;
    const period = r.ratioToPeriodMedian === null || r.ratioToPeriodMedian >= threshold;
    r.isOutlier = withPrimary.length >= minSample && overall && period;
  }
  if (withPrimary.length >= minSample && withPrimary.every((r) => r.ratioToPeriodMedian === null))
    caveats.push(`Not enough reels within ±${windowDays} days of each other to compare like-for-like periods; outliers use the overall median only.`);

  for (const k of ['views', 'likes', 'comments', 'engagement', 'engagementRate'] as const) rankBy(rows, k);

  return {
    primaryMetric: primary,
    primaryMetricReason: reason,
    sampleSize: rows.length,
    withPrimaryMetric: withPrimary.length,
    medians: {
      views: median(present(rows.map((r) => r.views))),
      likes: median(present(rows.map((r) => r.likes))),
      comments: median(present(rows.map((r) => r.comments))),
      engagement: median(present(rows.map((r) => r.engagement))),
      engagementRate: median(present(rows.map((r) => r.engagementRate))),
    },
    outlierThreshold: threshold,
    periodWindowDays: windowDays,
    reels: rows.sort((a, b) => (b.primaryValue ?? -1) - (a.primaryValue ?? -1)),
    outliers: rows.filter((r) => r.isOutlier).map((r) => r.shortcode),
    caveats,
  };
}

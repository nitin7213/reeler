import { describe, expect, it } from 'vitest';
import { extractContentFeatures, classifyScript, hookTypes } from '../src/analytics/content.js';
import { analyzePerformance, median } from '../src/analytics/performance.js';
import { estimateRemaining } from '../src/eta.js';
import { parseProfileUsername, parseReelShortcode } from '../src/instagram/urls.js';
import { mapApifyReel } from '../src/providers/discovery/apifyReelScraper.js';
import { classifyGraphError, MetaBusinessDiscoveryProvider } from '../src/providers/discovery/metaBusinessDiscovery.js';
import { classifyYtDlpError, mapYtDlpInfo } from '../src/providers/media/ytDlp.js';
import { parseWhisperJson } from '../src/providers/transcription/whisperCpp.js';

describe('instagram urls', () => {
  it.each([
    ['https://www.instagram.com/bvb09/', 'bvb09'],
    ['instagram.com/Some.User_1/reels/?igsh=abc', 'some.user_1'],
    ['@creator', 'creator'],
    ['https://www.instagram.com/reel/CsOS1ZhoQ55/', null],
    ['https://evil.com/bvb09', null],
    ['https://www.instagram.com:8080/bvb09', null],
  ])('profile %s -> %s', (input, expected) => expect(parseProfileUsername(input)).toBe(expected));

  it.each([
    ['https://www.instagram.com/reel/CsOS1ZhoQ55/?igsh=x', 'CsOS1ZhoQ55'],
    ['instagram.com/reels/Crv_gkItoi-', 'Crv_gkItoi-'],
    ['https://www.instagram.com/p/CrilSThplji/', 'CrilSThplji'],
    ['https://www.instagram.com/bvb09/reel/CsOS1ZhoQ55/', 'CsOS1ZhoQ55'],
    ['https://www.instagram.com/bvb09/', null],
    ['https://instagram.com.evil.com/reel/abcdef/', null],
  ])('reel %s -> %s', (input, expected) => expect(parseReelShortcode(input)).toBe(expected));
});

describe('yt-dlp provider mapping', () => {
  it('maps metrics without inventing views', () => {
    const r = mapYtDlpInfo(
      { channel: 'BVB09', description: 'cap', timestamp: 1684067737, like_count: 20780, comment_count: 43, formats: [{ acodec: 'mp4a.40.5', vcodec: 'none' }] },
      'CsOS1ZhoQ55',
    );
    expect(r.metrics).toEqual({ views: null, plays: null, likes: 20780, comments: 43, metricsHidden: null });
    expect(r.ownerUsername).toBe('bvb09');
    expect(r.publishedAt?.toISOString()).toBe('2023-05-14T12:35:37.000Z');
    expect(r.hasAudio).toBe(true);
  });

  it('classifies errors', () => {
    expect(classifyYtDlpError('ERROR: [Instagram] X: Instagram sent an empty media response. Check if ... cookies', 'y').kind).toBe('unavailable');
    expect(classifyYtDlpError('ERROR: HTTP Error 429: Too Many Requests', 'y').kind).toBe('throttled');
    expect(classifyYtDlpError('ERROR: This content is private', 'y').kind).toBe('private');
    expect(classifyYtDlpError('ERROR: HTTP Error 404: Not Found', 'y').kind).toBe('not_found');
    expect(classifyYtDlpError('ERROR: Requested content is not available, login required', 'y').kind).toBe('login_required');
  });
});

describe('meta business discovery', () => {
  const page = (data: object[], after?: string, next = true) =>
    new Response(JSON.stringify({ business_discovery: { id: '1', username: 'Creator', media_count: 3, media: { data, paging: after ? { cursors: { after }, ...(next ? { next: 'x' } : {}) } : undefined } } }));

  it('keeps only REELS, paginates by cursor, maps hidden likes', async () => {
    const calls: string[] = [];
    const responses = [
      page([{ id: 'a', permalink: 'https://www.instagram.com/reel/AAAAA1/', media_product_type: 'REELS', like_count: 10, comments_count: 2, view_count: 500, timestamp: '2026-01-01T00:00:00+0000' }, { id: 'b', permalink: 'https://www.instagram.com/p/BBBBB1/', media_product_type: 'FEED' }], 'c1'),
      page([{ id: 'c', shortcode: 'CCCCC1', media_product_type: 'REELS', comments_count: 1 }], 'c2', false),
    ];
    const p = new MetaBusinessDiscoveryProvider({ accessToken: 't', igUserId: '9', version: 'v23.0', fetchImpl: (async (url: URL) => (calls.push(String(url)), responses.shift()!)) as typeof fetch });
    const first = await p.listReels('creator', null, { limit: 50 });
    expect(first.reels.map((r) => r.shortcode)).toEqual(['AAAAA1']);
    expect(first.reels[0]!.metrics).toMatchObject({ views: 500, likes: 10, comments: 2 });
    expect(first.scannedMedia).toBe(2);
    expect(first.nextCursor).toBe('c1');
    const second = await p.listReels('creator', 'c1', { limit: 50 });
    expect(second.nextCursor).toBeNull();
    expect(second.reels[0]!.metrics.metricsHidden).toBe(true);
    expect(decodeURIComponent(calls[1]!)).toContain('.after(c1)');
    expect(calls[0]).not.toContain('access_token');
  });

  it('classifies graph errors', () => {
    expect(classifyGraphError({ code: 4 }, 400, 'm').kind).toBe('throttled');
    expect(classifyGraphError({ code: 190 }, 400, 'm').kind).toBe('config');
    expect(classifyGraphError({ code: 110, message: 'Invalid user id' }, 400, 'm').kind).toBe('not_found');
  });
});

describe('apify mapping', () => {
  it('treats -1 as hidden, not zero', () => {
    const r = mapApifyReel({ shortCode: 'X1234', likesCount: -1, commentsCount: 3, videoPlayCount: 900, videoViewCount: 400 })!;
    expect(r.metrics).toEqual({ views: 400, plays: 900, likes: null, comments: 3, metricsHidden: true });
  });
});

describe('whisper output', () => {
  it('drops music-only segments and reports no_speech', () => {
    const r = parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 13000 }, text: ' Music.' }] }, 'en', 0.5);
    expect(r.status).toBe('no_speech');
    expect(r.segments).toEqual([]);
    expect(r.language).toBeNull();
  });
  it('converts offsets to seconds', () => {
    const r = parseWhisperJson({ result: { language: 'de' }, transcription: [{ offsets: { from: 190, to: 1830 }, text: ' Scheine für Vereine ist zurück.' }] }, null, null);
    expect(r).toMatchObject({ status: 'completed', language: 'de', segments: [{ start: 0.19, end: 1.83, text: 'Scheine für Vereine ist zurück.' }] });
  });
});

describe('performance analytics', () => {
  const d = (day: number) => new Date(Date.UTC(2026, 0, day));
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('flags outliers against overall and period medians, never inventing metrics', () => {
    const reels = [100, 120, 90, 110, 1000, 95, null].map((views, i) => ({ shortcode: `r${i}`, publishedAt: d(i + 1), views, likes: 10, comments: 1 }));
    const s = analyzePerformance(reels);
    expect(s.primaryMetric).toBe('views');
    expect(s.medians.views).toBe(105);
    expect(s.outliers).toEqual(['r4']);
    const missing = s.reels.find((r) => r.shortcode === 'r6')!;
    expect(missing.views).toBeNull();
    expect(missing.engagementRate).toBeNull();
    expect(missing.isOutlier).toBe(false);
    expect(s.reels[0]!.ranks.views).toBe(1);
  });

  it('falls back to likes when views are missing and says so', () => {
    const s = analyzePerformance([1, 2, 3, 4, 5].map((i) => ({ shortcode: `r${i}`, publishedAt: null, views: null, likes: i * 10, comments: 0 })));
    expect(s.primaryMetric).toBe('likes');
    expect(s.caveats.join(' ')).toMatch(/not reach/);
  });

  it('refuses to flag outliers on tiny samples', () => {
    const s = analyzePerformance([{ shortcode: 'a', publishedAt: null, views: 10, likes: 1, comments: 0 }, { shortcode: 'b', publishedAt: null, views: 1000, likes: 1, comments: 0 }]);
    expect(s.outliers).toEqual([]);
    expect(s.caveats[0]).toMatch(/at least 5/);
  });
});

describe('content features', () => {
  it('classifies Hindi / Hinglish / English scripts', () => {
    expect(classifyScript('दोस्तों, आज मैं आपको बताएंगा', 'hi').language).toBe('hindi');
    expect(classifyScript('दोस्तों, आज मैं आपको बताएंगा कि Instagram पर viral reels कैसे बनाते हैं', 'hi').language).toBe('hinglish');
    expect(classifyScript('doston aaj main aapko bataunga', 'hi').language).toBe('hinglish');
    expect(classifyScript('Today I will tell you how', 'en').language).toBe('english');
  });

  it('detects hook types in English and Hindi', () => {
    expect(hookTypes('Why do 90% of creators fail?')).toContain('question');
    expect(hookTypes('3 mistakes you make on Instagram')).toEqual(expect.arrayContaining(['number_or_list', 'direct_address', 'bold_claim_or_warning']));
    expect(hookTypes('दोस्तों, आज मैं आपको बताऊँगा')).toContain('direct_address');
    expect(hookTypes('Ek baar main Delhi gaya tha')).toContain('story_open');
    expect(hookTypes('क्या आप जानते हो?')).toEqual(expect.arrayContaining(['question', 'direct_address']));
    // Devanagari substrings inside longer words must not match.
    expect(hookTypes('आपत्ति दर्ज')).toEqual(['statement']);
    expect(hookTypes('Do you know this?')).toContain('question');
  });

  it('extracts hook, pace and CTA', () => {
    const f = extractContentFeatures({
      segments: [
        { start: 0.2, end: 2.5, text: 'Kya aap jaante ho?' },
        { start: 3.2, end: 8, text: 'Pehla step hai strong hook.' },
        { start: 8, end: 10, text: 'Follow karo aur comment karo!' },
      ],
      transcript: null,
      detectedLanguage: 'hi',
      durationSeconds: 10,
    });
    expect(f.hook.text).toBe('Kya aap jaante ho?');
    expect(f.hook.types).toContain('question');
    expect(f.structure.hasNumberedSteps).toBe(true);
    expect(f.ending.ctaTypes).toEqual(expect.arrayContaining(['follow', 'comment']));
    expect(f.language).toBe('hinglish');
    expect(f.structure.wordsPerSecond).toBe(1.4);
  });
});

describe('time remaining estimate', () => {
  const base = { transcribe: true, mediaConcurrency: 1, transcriptionConcurrency: 1, avgFetchMs: 5000, transcribeMsPerAudioSecond: 500, avgReelSeconds: 40 };
  const task = (stage: string, durationSeconds: number | null = null, transcribingForMs: number | null = null) => ({ stage, durationSeconds, transcribingForMs }) as never;

  it('is unknown while discovering and zero when finished', () => {
    expect(estimateRemaining({ ...base, status: 'discovering', tasks: [] }).secondsRemaining).toBeNull();
    expect(estimateRemaining({ ...base, status: 'partial', tasks: [task('done')] }).secondsRemaining).toBe(0);
  });

  it('scales with audio length and counts down the reel being transcribed', () => {
    // 120s reel at 0.5s/s = 60s total; 20s already spent -> 40s left; plus a waiting 10s reel (5s).
    const tasks = [task('transcribing', 120, 20_000), task('waiting_transcription', 10), task('done', 30)];
    expect(estimateRemaining({ ...base, status: 'processing', tasks })).toMatchObject({ secondsRemaining: 45, basis: 'history' });
    // Ten seconds later the estimate has dropped by ten seconds.
    tasks[0] = task('transcribing', 120, 30_000);
    expect(estimateRemaining({ ...base, status: 'processing', tasks }).secondsRemaining).toBe(35);
  });

  it('uses average reel length for reels not downloaded yet, overlapping downloads', () => {
    // 4 to download: 20s of downloads + one 20s transcription = 40s; transcription backlog 4x20s = 80s dominates.
    const e = estimateRemaining({ ...base, status: 'processing', tasks: [task('queued'), task('queued'), task('queued'), task('fetching')] });
    expect(e.secondsRemaining).toBe(80);
  });

  it('ignores reels that will not be transcribed (below the view threshold)', () => {
    const tasks = [task('queued', 60), { ...task('queued', 60), skipTranscription: true }] as never[];
    // Downloads 2x5s + one 30s transcription = 40s; only one transcription in the backlog (30s).
    expect(estimateRemaining({ ...base, status: 'processing', tasks }).secondsRemaining).toBe(40);
  });

  it('falls back to defaults without history', () => {
    const e = estimateRemaining({ ...base, avgFetchMs: null, transcribeMsPerAudioSecond: null, avgReelSeconds: null, status: 'processing', tasks: [task('queued')] });
    expect(e.basis).toBe('default');
    expect(e.secondsRemaining).toBeGreaterThan(0);
  });
});

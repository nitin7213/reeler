import type { ReelView } from '../repository.js';
import { extractContentFeatures, type ContentFeatures } from './content.js';
import { analyzePerformance, median, type PerformanceSummary } from './performance.js';

export interface Hypothesis {
  statement: string;
  evidence: string;
  /** Always correlational; 'low' when the sample is small. */
  confidence: 'low' | 'medium';
}

export interface ProfileReport {
  generatedAt: string;
  username: string;
  measured: PerformanceSummary & { dataQuality: { reels: number; missingViews: number; missingLikes: number; missingComments: number; staleMetrics: number; transcribed: number; noSpeech: number } };
  content: Array<{ shortcode: string; isOutlier: boolean; features: ContentFeatures }>;
  hypotheses: Hypothesis[];
  disclaimer: string;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

/** Compare a boolean feature between outliers and the rest. Purely correlational. */
function compareFlag(name: string, outliers: ContentFeatures[], rest: ContentFeatures[], pick: (f: ContentFeatures) => boolean): Hypothesis | null {
  if (outliers.length < 2 || rest.length < 3) return null;
  const a = outliers.filter(pick).length / outliers.length;
  const b = rest.filter(pick).length / rest.length;
  if (Math.abs(a - b) < 0.3) return null;
  return {
    statement: `Outlier reels ${a > b ? 'more often' : 'less often'} ${name}.`,
    evidence: `${pct(outliers.filter(pick).length, outliers.length)} of ${outliers.length} outliers vs ${pct(rest.filter(pick).length, rest.length)} of ${rest.length} other reels.`,
    confidence: outliers.length >= 5 && rest.length >= 15 ? 'medium' : 'low',
  };
}

function compareNumber(name: string, unit: string, outliers: ContentFeatures[], rest: ContentFeatures[], pick: (f: ContentFeatures) => number | null): Hypothesis | null {
  const a = median(outliers.map(pick).filter((x): x is number => x !== null));
  const b = median(rest.map(pick).filter((x): x is number => x !== null));
  if (a === null || b === null || outliers.length < 2 || rest.length < 3 || b === 0) return null;
  if (Math.abs(a - b) / b < 0.25) return null;
  return {
    statement: `Outlier reels tend to have ${a > b ? 'higher' : 'lower'} ${name}.`,
    evidence: `Median ${a.toFixed(1)}${unit} for outliers vs ${b.toFixed(1)}${unit} for other reels.`,
    confidence: outliers.length >= 5 && rest.length >= 15 ? 'medium' : 'low',
  };
}

export function buildProfileReport(username: string, reels: ReelView[]): ProfileReport {
  const available = reels.filter((r) => r.availability === 'available');
  const perf = analyzePerformance(
    available.map((r) => ({ shortcode: r.shortcode, publishedAt: r.published_at, views: r.views ?? r.plays, likes: r.likes, comments: r.comments })),
  );
  const outlierSet = new Set(perf.outliers);
  const content = available
    .filter((r) => r.transcript_status === 'completed' || r.transcript_status === 'no_speech')
    .map((r) => ({
      shortcode: r.shortcode,
      isOutlier: outlierSet.has(r.shortcode),
      features: extractContentFeatures({ segments: r.segments, transcript: r.transcript, detectedLanguage: r.language, durationSeconds: r.duration_seconds }),
    }));

  const o = content.filter((c) => c.isOutlier).map((c) => c.features);
  const rest = content.filter((c) => !c.isOutlier).map((c) => c.features);
  const hypotheses = [
    compareFlag('open with a question', o, rest, (f) => f.hook.types.includes('question')),
    compareFlag('open by addressing the viewer directly', o, rest, (f) => f.hook.types.includes('direct_address')),
    compareFlag('open with a number or list promise', o, rest, (f) => f.hook.types.includes('number_or_list')),
    compareFlag('open with a bold claim or warning', o, rest, (f) => f.hook.types.includes('bold_claim_or_warning')),
    compareFlag('use first-person storytelling', o, rest, (f) => f.storytelling.firstPersonNarrative),
    compareFlag('end with a call to action', o, rest, (f) => f.ending.hasCallToAction),
    compareFlag('use numbered steps', o, rest, (f) => f.structure.hasNumberedSteps),
    compareFlag('are spoken in Hinglish', o, rest, (f) => f.language === 'hinglish'),
    compareNumber('duration', 's', o, rest, (f) => f.durationSeconds),
    compareNumber('speaking pace', ' words/s', o, rest, (f) => f.structure.wordsPerSecond),
    compareNumber('time before the first spoken word', 's', o, rest, (f) => f.hook.firstWordAtSeconds),
  ].filter((h): h is Hypothesis => h !== null);

  return {
    generatedAt: new Date().toISOString(),
    username,
    measured: {
      ...perf,
      dataQuality: {
        reels: available.length,
        missingViews: available.filter((r) => r.views === null && r.plays === null).length,
        missingLikes: available.filter((r) => r.likes === null).length,
        missingComments: available.filter((r) => r.comments === null).length,
        staleMetrics: available.filter((r) => r.stale_metrics.length > 0).length,
        transcribed: available.filter((r) => r.transcript_status === 'completed').length,
        noSpeech: available.filter((r) => r.transcript_status === 'no_speech').length,
      },
    },
    content,
    hypotheses,
    disclaimer:
      '`measured` contains only values returned by the data source (null = not available, never estimated). ' +
      '`hypotheses` are correlations between script features and measured outliers on a small sample; they are ' +
      'not causal and ignore factors we cannot observe (trending audio, paid promotion, collaborations, posting time, algorithm changes).',
  };
}

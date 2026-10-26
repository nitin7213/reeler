import type { TranscriptSegment } from '../providers/types.js';

/**
 * Deterministic, explainable script features extracted from a transcript.
 * These describe *what the reel does*; they are inputs for LLM analysis and
 * hypothesis generation, not judgements of quality.
 */

export type HookType = 'question' | 'number_or_list' | 'direct_address' | 'bold_claim_or_warning' | 'story_open' | 'statement';
export type ScriptLanguage = 'hindi' | 'english' | 'hinglish' | 'other' | 'none';

export interface ContentFeatures {
  hasSpeech: boolean;
  language: ScriptLanguage;
  detectedLanguage: string | null;
  devanagariShare: number | null;
  hook: { text: string; types: HookType[]; firstWordAtSeconds: number | null };
  structure: { segments: number; words: number; wordsPerSecond: number | null; speechCoverage: number | null; hasNumberedSteps: boolean };
  storytelling: { firstPersonNarrative: boolean; markers: string[] };
  ending: { text: string; hasCallToAction: boolean; ctaTypes: string[] };
  durationSeconds: number | null;
}

// Each list mixes English, romanized Hindi and Devanagari forms. `\b` is ASCII-only in JS,
// so word boundaries are Unicode-aware lookarounds (letters + combining marks).
const words = (alternatives: string, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`, flags);

const QUESTION = new RegExp(`\\?|^\\s*${words('why|how|what|did you|do you|have you|kya|kaise|kyun|kyon|kab|kaun|क्या|कैसे|क्यों|कब|कौन').source}`, 'iu');
const NUMBER_LIST = new RegExp(
  `(?:\\d+|${words('one|two|three|five|top|ek|do|teen|paanch|पहला|दूसरा|तीन|पांच').source}).*${words('tips?|ways?|things?|mistakes?|steps?|reasons?|tarike|cheezein|baatein|गलतियां|तरीके|चीज़ें').source}`,
  'iu',
);
const DIRECT = words("you|your|you're|aap|aapko|aapka|tum|tumhe|doston|dosto|guys|friends|दोस्तों|आप|आपको|तुम|तुम्हें");
const BOLD = new RegExp(`!|${words("never|stop|don't|nobody|secrets?|mistakes?|truth|wrong|biggest|mat|galti|galtiyan|sach|koi nahi|बंद|गलती|गलतियां|सच|कभी नहीं").source}`, 'iu');
const STORY = words('when i|i was|last year|last week|one day|ek baar|jab main|jab maine|maine|एक बार|जब मैं|मैंने');
const STEPS = words('first|second|third|step|number one|pehla|doosra|teesra|पहला|दूसरा|तीसरा|स्टेप');
const STORY_MARKERS: Array<[string, RegExp]> = [
  ['first_person_past', words('i was|i had|i did|maine|main tha|main thi|मैंने|मैं था|मैं थी')],
  ['time_jump', words('then|after that|suddenly|phir|uske baad|achanak|फिर|उसके बाद|अचानक')],
  ['conflict', words('but|problem|failed|struggle|lekin|magar|dikkat|लेकिन|मगर|दिक्कत')],
  ['resolution', words("finally|that's when|realised|realized|aakhir|tab samjha|आखिर|तब समझ")],
];
const CTA: Array<[string, RegExp]> = [
  ['follow', words('follow|फॉलो')],
  ['comment', words('comment|कमेंट')],
  ['share', words('share|शेयर')],
  ['save', words('save|सेव')],
  ['link', words('link in bio|bio|link|लिंक')],
  ['like', words('like|लाइक')],
];

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;

export function classifyScript(text: string, detected: string | null): { language: ScriptLanguage; devanagariShare: number | null } {
  const d = text.match(DEVANAGARI)?.length ?? 0;
  const l = text.match(LATIN)?.length ?? 0;
  if (d + l === 0) return { language: text.trim() ? 'other' : 'none', devanagariShare: null };
  const share = d / (d + l);
  // Romanized Hinglish is all-Latin but detected as Hindi.
  if (detected === 'hi' && share < 0.1) return { language: 'hinglish', devanagariShare: share };
  if (share > 0.9) return { language: 'hindi', devanagariShare: share };
  if (share >= 0.1) return { language: 'hinglish', devanagariShare: share };
  if (detected && !['en', 'hi'].includes(detected)) return { language: 'other', devanagariShare: share };
  return { language: 'english', devanagariShare: share };
}

export function hookTypes(hook: string): HookType[] {
  const types: HookType[] = [];
  if (QUESTION.test(hook)) types.push('question');
  if (NUMBER_LIST.test(hook)) types.push('number_or_list');
  if (DIRECT.test(hook)) types.push('direct_address');
  if (BOLD.test(hook)) types.push('bold_claim_or_warning');
  if (STORY.test(hook)) types.push('story_open');
  return types.length ? types : ['statement'];
}

export function extractContentFeatures(input: {
  segments: TranscriptSegment[] | null;
  transcript: string | null;
  detectedLanguage: string | null;
  durationSeconds: number | null;
  hookSeconds?: number;
}): ContentFeatures {
  const segments = input.segments ?? [];
  const text = (input.transcript ?? segments.map((s) => s.text).join(' ')).trim();
  const hookWindow = input.hookSeconds ?? 3;
  const duration = input.durationSeconds;

  // Hook: everything spoken before `hookSeconds`, or at least the first segment.
  const hookSegs = segments.filter((s) => s.start < hookWindow);
  const hookText = (hookSegs.length ? hookSegs : segments.slice(0, 1)).map((s) => s.text).join(' ').trim();
  const lastText = segments.slice(-2).map((s) => s.text).join(' ').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const spoken = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  const ctaTypes = CTA.filter(([, re]) => re.test(lastText)).map(([k]) => k);
  const markers = STORY_MARKERS.filter(([, re]) => re.test(text)).map(([k]) => k);
  const script = classifyScript(text, input.detectedLanguage);

  return {
    hasSpeech: words > 0,
    language: script.language,
    detectedLanguage: input.detectedLanguage,
    devanagariShare: script.devanagariShare,
    hook: { text: hookText, types: hookText ? hookTypes(hookText) : [], firstWordAtSeconds: segments[0]?.start ?? null },
    structure: {
      segments: segments.length,
      words,
      wordsPerSecond: duration && words ? +(words / duration).toFixed(2) : null,
      speechCoverage: duration && spoken ? +Math.min(1, spoken / duration).toFixed(2) : null,
      hasNumberedSteps: STEPS.test(text),
    },
    storytelling: { firstPersonNarrative: markers.includes('first_person_past'), markers },
    ending: { text: lastText, hasCallToAction: ctaTypes.length > 0, ctaTypes },
    durationSeconds: duration,
  };
}

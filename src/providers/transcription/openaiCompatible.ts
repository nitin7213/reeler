import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CancelledError } from '../../util/exec.js';
import { ProviderError, type TranscriptionProvider, type TranscriptionResult } from '../types.js';

interface VerboseJson {
  text?: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number }>;
}

/**
 * Hosted speech-to-text for any OpenAI-compatible `/audio/transcriptions`
 * endpoint (OpenAI, Groq, a self-hosted faster-whisper server, ...).
 * Cost is estimated from audio duration × configured per-minute price.
 */
export class OpenAICompatibleTranscriber implements TranscriptionProvider {
  readonly name = 'openai_compatible';
  readonly model: string;
  readonly hosted = true;

  constructor(private readonly opts: { baseUrl: string; apiKey: string; model: string; usdPerMinute: number; translate: boolean }) {
    this.model = opts.model;
  }

  async transcribe(wavPath: string, durationSeconds: number, signal?: AbortSignal): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('file', new Blob([await readFile(wavPath)], { type: 'audio/wav' }), path.basename(wavPath));
    form.set('model', this.opts.model);
    form.set('response_format', 'verbose_json');
    form.set('timestamp_granularities[]', 'segment');

    const body = await this.post('transcriptions', form, signal);
    const result = toResult(body);
    let english = result.status === 'completed' && result.language && /^(en|english)$/i.test(result.language) ? { text: result.text, segments: result.segments } : null;
    let minutesBilled = Math.max(durationSeconds, 1) / 60;
    if (this.opts.translate && result.status === 'completed' && !english) {
      const tf = new FormData();
      tf.set('file', form.get('file')!);
      tf.set('model', this.opts.model);
      tf.set('response_format', 'verbose_json');
      const t = toResult(await this.post('translations', tf, signal));
      english = t.status === 'completed' ? { text: t.text, segments: t.segments } : null;
      minutesBilled *= 2;
    }
    return { ...result, english, costUsd: minutesBilled * this.opts.usdPerMinute };
  }

  private async post(endpoint: 'transcriptions' | 'translations', form: FormData, signal?: AbortSignal): Promise<VerboseJson> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/audio/${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
    }).catch((err: Error) => {
      if (signal?.aborted) throw new CancelledError();
      throw new ProviderError('transient', `transcription request failed: ${err.message}`, this.name);
    });
    if (res.status === 429) throw new ProviderError('throttled', 'speech-to-text rate limit (HTTP 429)', this.name);
    if (res.status === 401 || res.status === 403) throw new ProviderError('config', `speech-to-text rejected the API key (HTTP ${res.status})`, this.name);
    if (!res.ok) throw new ProviderError(res.status >= 500 ? 'transient' : 'unknown', `speech-to-text HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, this.name);

    return (await res.json()) as VerboseJson;
  }
}

function toResult(body: VerboseJson): Omit<TranscriptionResult, 'english' | 'costUsd'> {
  const segments = (body.segments ?? [])
    .filter((s) => (s.no_speech_prob ?? 0) < 0.8)
    .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    .filter((s) => s.text);
  const text = segments.length ? segments.map((s) => s.text).join(' ') : (body.text ?? '').trim();
  return {
    status: text ? 'completed' : 'no_speech',
    language: text ? (body.language ?? null) : null,
    languageProbability: null,
    text,
    segments,
  };
}

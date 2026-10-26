import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CancelledError, run } from '../../util/exec.js';
import { ProviderError, type TranscriptionProvider, type TranscriptionResult, type TranscriptSegment } from '../types.js';

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets: { from: number; to: number }; text: string }>;
}

// Whisper's typical output for music/silence when there is no speech.
const NON_SPEECH = /^\s*[[(]?\s*(music|musik|música|applause|silence|blank_audio|no speech|♪+|instrumental)\s*[\])]?\s*[.!]?\s*$/i;
const HINDI_FAMILY = new Set(['hi', 'ur']);

/**
 * Local transcription with whisper.cpp (Metal-accelerated on Apple Silicon).
 * Two passes: a ~2s language detection, then the real decode. When Hindi/Urdu
 * is detected we decode as Hindi with a romanized Hinglish prompt; this keeps
 * English words ("hook", "Instagram") in Latin script instead of transliterating
 * them to Devanagari. Silero VAD skips music-only stretches.
 */
export class WhisperCppTranscriber implements TranscriptionProvider {
  readonly name = 'whisper_cpp';
  readonly model: string;

  constructor(
    private readonly opts: {
      bin: string;
      modelPath: string;
      vadModelPath?: string;
      threads: number;
      language: string;
      hinglishPrompt?: string;
      /** Model for the English pass. large-v3-turbo was not trained to translate, so use full large-v3. */
      translateModelPath?: string | null;
      /** Model for Hindi/Urdu originals (turbo drops chunks of fast Hindi speech). */
      hindiModelPath?: string | null;
    },
  ) {
    const name = (p: string) => path.basename(p).replace(/\.bin$/, '');
    // The cache key includes every model involved, so changing models re-processes old transcripts once.
    this.model = [
      name(opts.modelPath),
      opts.hindiModelPath ? `hi:${name(opts.hindiModelPath)}` : null,
      opts.translateModelPath ? `en:${name(opts.translateModelPath)}` : null,
    ].filter(Boolean).join('+');
  }

  async transcribe(wavPath: string, _durationSeconds?: number, signal?: AbortSignal): Promise<TranscriptionResult> {
    await access(this.opts.modelPath).catch(() => {
      throw new ProviderError('config', `Whisper model not found at ${this.opts.modelPath}. See README "Setup".`, this.name);
    });
    const vad = await this.vadArgs();
    const base = ['-m', this.opts.modelPath, '-f', wavPath, '-t', String(this.opts.threads), ...vad];

    let language = this.opts.language;
    let languageProbability: number | null = null;
    if (language === 'auto') {
      const det = await this.exec([...base, '-dl'], signal);
      const m = det.stderr.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/);
      if (m) {
        language = m[1]!;
        languageProbability = Number(m[2]);
      }
    }

    const hindi = HINDI_FAMILY.has(language);
    const hindiModel = hindi && this.opts.hindiModelPath && (await access(this.opts.hindiModelPath).then(() => true, () => false)) ? this.opts.hindiModelPath : null;
    const args = [...(hindiModel ? ['-m', hindiModel, ...base.slice(2)] : base), '-l', hindi ? 'hi' : language];
    if (HINDI_FAMILY.has(language) && this.opts.hinglishPrompt) args.push('--prompt', this.opts.hinglishPrompt);

    const translateArgs = (model: string) => ['-m', model, '-f', wavPath, '-t', String(this.opts.threads), ...vad, '-l', HINDI_FAMILY.has(language) ? 'hi' : language, '-tr'];
    const result = parseWhisperJson(await this.decode(args, signal), language === 'auto' ? null : language, languageProbability);
    if (result.status !== 'completed' || !this.opts.translateModelPath) return result;
    if (result.language === 'en') return { ...result, english: { text: result.text, segments: result.segments } };

    await access(this.opts.translateModelPath).catch(() => {
      throw new ProviderError('config', `Translation model not found at ${this.opts.translateModelPath}. See README "Setup".`, this.name);
    });
    const translated = parseWhisperJson(
      await this.decode(translateArgs(this.opts.translateModelPath), signal),
      'en',
      null,
    );
    return { ...result, english: translated.status === 'completed' ? { text: translated.text, segments: translated.segments } : null };
  }

  private async decode(args: string[], signal?: AbortSignal): Promise<WhisperJson> {
    const outDir = await mkdtemp(path.join(tmpdir(), 'whisper-'));
    const outPrefix = path.join(outDir, 'out');
    try {
      await this.exec([...args, '-oj', '-of', outPrefix, '-np'], signal);
      return JSON.parse(await readFile(`${outPrefix}.json`, 'utf8')) as WhisperJson;
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }

  private async vadArgs(): Promise<string[]> {
    if (!this.opts.vadModelPath) return [];
    try {
      await access(this.opts.vadModelPath);
      return ['--vad', '-vm', this.opts.vadModelPath];
    } catch {
      return [];
    }
  }

  private async exec(args: string[], signal?: AbortSignal) {
    let res;
    try {
      res = await run(this.opts.bin, args, { timeoutMs: 30 * 60_000, signal });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw new ProviderError('config', `cannot run ${this.opts.bin}: ${(err as Error).message}`, this.name);
    }
    if (res.code !== 0) throw new ProviderError('unknown', `whisper-cli exited ${res.code}: ${res.stderr.slice(-500)}`, this.name);
    return res;
  }
}

export function parseWhisperJson(json: WhisperJson, detected: string | null, probability: number | null): TranscriptionResult {
  const segments: TranscriptSegment[] = (json.transcription ?? [])
    .map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() }))
    .filter((s) => s.text.length > 0 && !NON_SPEECH.test(s.text));
  const text = segments.map((s) => s.text).join(' ').trim();
  return {
    status: text ? 'completed' : 'no_speech',
    // Whisper still "detects" a language on music-only audio; don't report it.
    language: text ? (detected ?? json.result?.language ?? null) : null,
    languageProbability: text ? probability : null,
    text,
    segments,
    english: null,
    costUsd: 0,
  };
}

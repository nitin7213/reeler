import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ProviderError } from '../providers/types.js';
import { run } from '../util/exec.js';

/**
 * Convert any downloaded media (audio-only m4a, or a full mp4 when no audio-only
 * stream exists) to 16 kHz mono PCM WAV, which every Whisper variant accepts.
 */
export async function normalizeToWav(ffmpegBin: string, input: string, output: string): Promise<void> {
  const res = await run(ffmpegBin, ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], {
    timeoutMs: 10 * 60_000,
  }).catch((err: Error) => {
    throw new ProviderError('config', `cannot run ${ffmpegBin}: ${err.message}`, 'ffmpeg');
  });
  if (res.code !== 0) {
    const noAudio = /does not contain any stream|matches no streams|Output file #0 does not contain/i.test(res.stderr);
    throw new ProviderError(noAudio ? 'no_audio' : 'unknown', `ffmpeg failed: ${res.stderr.slice(-400)}`, 'ffmpeg');
  }
}

export async function probeDurationSeconds(ffprobeBin: string, file: string): Promise<number | null> {
  const res = await run(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 60_000 }).catch(
    () => null,
  );
  const n = res && res.code === 0 ? Number(res.stdout.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return { sha256: hash.digest('hex'), bytes: (await stat(file)).size };
}

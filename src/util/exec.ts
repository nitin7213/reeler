import { spawn } from 'node:child_process';

/** Thrown when work is stopped by the user (import cancelled). */
export class CancelledError extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'CancelledError';
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary without a shell (no injection surface) and capture output. */
export function run(bin: string, args: string[], opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    // Stopping an import kills the running process right away.
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : undefined;
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new CancelledError());
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        code: code ?? (signal ? 137 : 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: signal ? `${stderr}\nkilled by ${signal}` : stderr,
      });
    });
  });
}

/** Serializes calls so consecutive calls are at least `minIntervalMs` apart (per process). */
export class Pacer {
  private next = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const delay = this.next - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this.next = Date.now() + this.minIntervalMs;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

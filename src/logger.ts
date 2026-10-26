import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'reel-ingest' },
    // Never log secrets even if a provider error echoes a request.
    redact: { paths: ['*.token', '*.access_token', '*.apiKey', '*.authorization', 'headers.authorization'], censor: '[redacted]' },
  });
}

import { ProviderError } from './types.js';

/**
 * Run an Apify actor synchronously and return its dataset items.
 * Token goes in the Authorization header, never the URL, so it stays out of logs.
 */
export async function runApifyActor<T>(token: string, actor: string, input: unknown, provider: string, timeoutSecs = 300): Promise<T[]> {
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=${timeoutSecs}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout((timeoutSecs + 30) * 1000),
    });
  } catch (err) {
    throw new ProviderError('transient', `Apify request failed: ${(err as Error).message}`, provider);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('config', `Apify rejected the token (HTTP ${res.status})`, provider);
  if (res.status === 402) throw new ProviderError('config', 'Apify account has insufficient credit (HTTP 402)', provider);
  if (res.status === 429) throw new ProviderError('throttled', 'Apify rate limit (HTTP 429)', provider);
  if (!res.ok) throw new ProviderError('transient', `Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, provider);
  return (await res.json()) as T[];
}

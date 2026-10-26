const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer', 'legal']);
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

function parse(input: string): URL | null {
  const value = input.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!IG_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

/** `https://instagram.com/name/reels?igsh=..` -> `name`. Accepts a bare `@name` too. */
export function parseProfileUsername(input: string): string | null {
  const bare = input.trim().replace(/^@/, '');
  if (USERNAME_RE.test(bare) && !bare.includes('/')) return bare.toLowerCase();
  const url = parse(input);
  if (!url) return null;
  const [first] = url.pathname.split('/').filter(Boolean);
  if (!first || RESERVED.has(first.toLowerCase()) || !USERNAME_RE.test(first)) return null;
  return first.toLowerCase();
}

/** Reel or post URL -> shortcode. Posts (/p/) are accepted because many Reels are linked that way. */
export function parseReelShortcode(input: string): string | null {
  const url = parse(input);
  if (!url) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // /reel/X, /reels/X, /p/X, /tv/X, or /username/reel/X
  const idx = parts.findIndex((p) => ['reel', 'reels', 'p', 'tv'].includes(p.toLowerCase()));
  const code = idx >= 0 ? parts[idx + 1] : undefined;
  return code && SHORTCODE_RE.test(code) ? code : null;
}

export function canonicalReelUrl(shortcode: string): string {
  return `https://www.instagram.com/reel/${shortcode}/`;
}

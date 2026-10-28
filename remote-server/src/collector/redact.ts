/**
 * Redaction and clipping, ported from collector.py (`SECRETS`, `redact`,
 * `clip`) so a report or a turn says exactly what the Python collector would.
 * Lengths count code points, as Python's str and Pydantic's max_length do.
 *
 * SECRET_PATTERNS is the one list both sides use (stage F, L6): Eridani's
 * `apps/api/jarvis/redaction.py` compiles the same strings, and
 * docs/remotea/redaction.md is the canonical copy with test vectors. Change
 * all three together. No inline flags (JS and Python differ): case is
 * spelled out with character classes, and `(?![\s\S])` is end of input.
 */
export const SECRET_PATTERNS: readonly string[] = Object.freeze([
  'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}',
  'gh[pousr]_[A-Za-z0-9]{30,}',
  'github_pat_[A-Za-z0-9_]{30,}',
  'AKIA[0-9A-Z]{16}',
  'xox[abpr]-[A-Za-z0-9-]{10,}',
  'eri_bot_[A-Za-z0-9_-]{20,}',
  'lin_api_[A-Za-z0-9]{20,}',
  '[Bb][Ee][Aa][Rr][Ee][Rr]\\s+[A-Za-z0-9._~+/=-]{20,}',
  // Stage F additions.
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?![\\s\\S]))',
  '://[^/\\s:@]+:[^/\\s@]+@',
  '(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii]_[Kk][Ee][Yy])\\s*[=:]\\s*\\S{8,}',
]);

export const SECRETS = new RegExp(`(${SECRET_PATTERNS.join('|')})`, 'g');

export function redact(text: string | null | undefined): string {
  return (text || '').replace(SECRETS, '[redacted]');
}

/** Python's str.strip(): the whitespace set str.isspace() accepts. */
export function pyStrip(text: string): string {
  return text.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, '');
}

export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function clip(text: string | null | undefined, limit: number): string {
  const t = pyStrip(redact(text));
  if (t.length <= limit || codePointLength(t) <= limit) return t;
  return Array.from(t).slice(0, limit - 1).join('') + '…';
}

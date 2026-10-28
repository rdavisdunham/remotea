/**
 * `json.dumps(value, sort_keys=True)` with Python's defaults (", " and ": "
 * separators, ensure_ascii) and its sha256 — collector.py's `digest()`, so a
 * fingerprint means the same thing in both collectors.
 */
import crypto from 'crypto';

function pyString(s: string): string {
  return JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return pyString(value);
  if (Array.isArray(value)) return value.length ? `[${value.map(pyJsonDumps).join(', ')}]` : '[]';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return keys.length ? `{${keys.map((k) => `${pyString(k)}: ${pyJsonDumps(obj[k])}`).join(', ')}}` : '{}';
}

export function pyDigest(value: unknown): string {
  return crypto.createHash('sha256').update(pyJsonDumps(value)).digest('hex');
}

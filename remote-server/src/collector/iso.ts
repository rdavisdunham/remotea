/**
 * collector.py's `iso()`: epoch seconds or milliseconds, or an ISO string,
 * as Python's `datetime.isoformat()` spells an aware UTC time —
 * `2026-10-20T10:05:00+00:00`, with `.ffffff` only when there are microseconds.
 */

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function format(totalMicros: number): string {
  const ms = Math.floor(totalMicros / 1000);
  const micros = ((totalMicros % 1_000_000) + 1_000_000) % 1_000_000;
  const d = new Date(ms);
  const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${base}${micros ? '.' + pad(micros, 6) : ''}+00:00`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?)?(?:([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;

export function pyIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    return format(v > 1e11 ? Math.round(v * 1000) : Math.round(v * 1e6));
  }
  const m = ISO_RE.exec(String(value).replace(/Z/g, '+00:00'));
  if (!m) return null;
  const [, Y, Mo, D, h = '0', mi = '0', s = '0', frac = '', sign, oh, om, os] = m;
  const micros = Number((frac + '000000').slice(0, 6));
  const parts = [Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), Number(s)] as const;
  if (parts[1] > 11 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
  let epochMs: number;
  if (sign) {
    const off = (Number(oh) * 3600 + Number(om) * 60 + Number(os ?? 0)) * (sign === '-' ? -1 : 1);
    epochMs = Date.UTC(...parts) - off * 1000;
    if (new Date(Date.UTC(...parts)).getUTCDate() !== parts[2]) return null;
  } else {
    // A naive time is local time, as `.astimezone(UTC)` reads it.
    const local = new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
    if (local.getDate() !== parts[2]) return null;
    epochMs = local.getTime();
  }
  return format(epochMs * 1000 + micros);
}

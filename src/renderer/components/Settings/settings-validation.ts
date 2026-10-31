/** Empty uses Remotea's built-in page. Explicit schemes preserve custom protocol compatibility. */
export function isValidStartUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^about:/i.test(value)) return false;
  try { const url = new URL(value); return !['http:', 'https:'].includes(url.protocol) || !!url.hostname; } catch { return false; }
}
export function boundedInteger(value: string, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : min;
}
export function canAddScheme(name: string, existing: string[]): boolean {
  return !!name.trim() && !existing.some(value => value.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
}



export function parseCliValue(raw: string): unknown {
  if (raw.length === 0) return '';
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

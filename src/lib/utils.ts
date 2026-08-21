export function asFiniteNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeCurrency(value: string | undefined): string {
  if (!value) return '';
  const normalized = value.trim();
  return /^gbx$/i.test(normalized) || /^gbp$/i.test(normalized)
    ? normalized.toUpperCase() === 'GBX'
      ? 'GBX'
      : 'GBP'
    : normalized.toUpperCase();
}

export function decimalString(value: number | undefined, scale = 12): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(scale));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function isoDate(value: unknown): string | undefined {
  const text = asNonEmptyString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${hash.toString(16).padStart(16, '0')}-${text.length}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function encodeBasicCredentials(apiKey: string, apiSecret: string): string {
  const raw = `${apiKey.trim()}:${apiSecret.trim()}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
    .replace(/(api[_ -]?secret|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

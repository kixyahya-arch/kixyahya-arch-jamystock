/** Aléa portable (Node ≥ 19 et navigateurs) : l'app terrain génère ses identifiants hors-ligne. */
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * UUID v7 (RFC 9562) : triable dans le temps et générable hors-ligne (§5).
 * Le terminal terrain génère ses propres identifiants, le serveur les accepte tels quels.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * QR codes (§7.6) : https://q.jamystock.fr/{TYPE}/{code}
 * code = 10 caractères base32 sans caractères ambigus (pas de 0/O, 1/I/L, U).
 * TYPE : A = article, U = unité de manutention, E = emplacement.
 */
export const QR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');
export const QR_CODE_LENGTH = 10;
export type QrType = 'A' | 'U' | 'E';
export const DEFAULT_QR_BASE_URL = 'https://q.jamystock.fr';

export function generateQrCode(type: QrType): string {
  const bytes = randomBytes(QR_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < QR_CODE_LENGTH; i++) {
    // biais négligeable (256 % 30 = 16) pour un identifiant non cryptographique
    code += QR_ALPHABET[bytes[i]! % QR_ALPHABET.length];
  }
  return `${type}${code}`;
}

export function qrUrl(qr: string, baseUrl: string = DEFAULT_QR_BASE_URL): string {
  const type = qr[0];
  return `${baseUrl}/${type}/${qr.slice(1)}`;
}

const QR_RE = new RegExp(`^([AUE])([${QR_ALPHABET.join('')}]{${QR_CODE_LENGTH}})$`);

/** Accepte soit le code brut ("A7KX..."), soit l'URL scannée. */
export function parseQr(input: string): { type: QrType; qr: string } | null {
  let raw = input.trim();
  const urlMatch = raw.match(/\/([AUE])\/([A-Z0-9]+)\/?$/i);
  if (urlMatch) raw = `${urlMatch[1]}${urlMatch[2]}`;
  raw = raw.toUpperCase();
  const m = raw.match(QR_RE);
  if (!m) return null;
  return { type: m[1] as QrType, qr: raw };
}


import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { blContent, pickupContent, type BlSignPayload, type PickupSignPayload } from './sync.js';

/** Empreintes SHA-256 côté serveur (Node). Le terminal calcule la même avec SubtleCrypto sur canonicalJson(...). */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function blFingerprint(p: Omit<BlSignPayload, 'empreinte' | 'gps'>): string {
  return fingerprint(blContent(p));
}

export function pickupFingerprint(p: Omit<PickupSignPayload, 'empreinte' | 'gps'>): string {
  return fingerprint(pickupContent(p));
}

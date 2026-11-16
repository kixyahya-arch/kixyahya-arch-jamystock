import { blContent, canonicalJson, pickupContent, type BlSignPayload, type PickupSignPayload } from '@jamystock/domain/browser';

/** SHA-256 hexadécimal avec SubtleCrypto : même résultat que le serveur sur canonicalJson(...). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const blFingerprint = (p: Omit<BlSignPayload, 'empreinte' | 'gps'>) => sha256Hex(canonicalJson(blContent(p)));
export const pickupFingerprint = (p: Omit<PickupSignPayload, 'empreinte' | 'gps'>) => sha256Hex(canonicalJson(pickupContent(p)));

/**
 * Compression locale avant envoi (§7.6) : 2 048 px sur le grand côté, WebP qualité 80 (JPEG 80 en repli).
 * Le passage par un canvas supprime les métadonnées EXIF ; la date de prise est conservée à part.
 */
export async function compressPhoto(file: Blob, maxSide = 2048, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  const webp = await toBlob('image/webp');
  if (webp && webp.type === 'image/webp') return webp;
  return (await toBlob('image/jpeg'))!;
}

/** Retours haptique et sonore (REC-03) : vert = bip aigu court, erreur = double bip grave et vibration longue. */
let audio: AudioContext | null = null;
export function feedback(kind: 'ok' | 'error') {
  try {
    navigator.vibrate?.(kind === 'ok' ? 40 : [120, 60, 120]);
    audio ??= new AudioContext();
    const beep = (freq: number, start: number, dur: number) => {
      const o = audio!.createOscillator();
      const g = audio!.createGain();
      o.frequency.value = freq;
      g.gain.value = 0.15;
      o.connect(g).connect(audio!.destination);
      o.start(audio!.currentTime + start);
      o.stop(audio!.currentTime + start + dur);
    };
    if (kind === 'ok') beep(1320, 0, 0.08);
    else {
      beep(330, 0, 0.12);
      beep(330, 0.18, 0.12);
    }
  } catch {
    /* pas de son ni de vibration disponible */
  }
}

export function currentPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number; precision: number } | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, precision: Math.round(p.coords.accuracy) }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

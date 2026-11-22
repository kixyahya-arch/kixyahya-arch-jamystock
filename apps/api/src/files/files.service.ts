import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export type PhotoSize = 't' | 'm' | 'o';
export const PHOTO_SIZES: readonly PhotoSize[] = ['t', 'm', 'o'];

/** Durée de validité des liens de fichiers (§7.3 : URL signées de 15 min). */
const TTL_S = 15 * 60;
/** Les échéances sont arrondies à 5 min : un même lien sert plusieurs pages, le navigateur peut le mettre en cache. */
const BUCKET_S = 5 * 60;

/**
 * Liens signés vers les fichiers. Une balise <img> ne peut pas envoyer de jeton d'accès : le lien porte
 * lui-même l'autorisation (organisation, fichier, taille, échéance), scellée par HMAC. Le droit de voir la
 * photo est vérifié au moment où le lien est émis, sous la RLS de l'utilisateur.
 */
@Injectable()
export class FilesService {
  private readonly key: Buffer;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.key = createHmac('sha256', config.jwtSecret).update('jamystock:files:v1').digest();
  }

  private sig(tenantId: string, photoId: string, size: PhotoSize | 'a', exp: number): string {
    return createHmac('sha256', this.key).update(`${tenantId}.${photoId}.${size}.${exp}`).digest('base64url');
  }

  photoUrl(tenantId: string, photoId: string, size: PhotoSize, now = Date.now()): string {
    const exp = Math.ceil((now / 1000 + TTL_S) / BUCKET_S) * BUCKET_S;
    return `/api/v1/files/photos/${photoId}/${size}?t=${tenantId}&e=${exp}&s=${this.sig(tenantId, photoId, size, exp)}`;
  }

  /** Visuel d'aménagement d'une pièce de pack (table pack_ambiance). */
  ambianceUrl(tenantId: string, id: string, now = Date.now()): string {
    const exp = Math.ceil((now / 1000 + TTL_S) / BUCKET_S) * BUCKET_S;
    return `/api/v1/files/ambiances/${id}?t=${tenantId}&e=${exp}&s=${this.sig(tenantId, id, 'a', exp)}`;
  }

  photoUrls(tenantId: string, photoId: string) {
    return { vignette: this.photoUrl(tenantId, photoId, 't'), moyenne: this.photoUrl(tenantId, photoId, 'm'), originale: this.photoUrl(tenantId, photoId, 'o') };
  }

  verify(tenantId: string, photoId: string, size: PhotoSize | 'a', exp: number, sig: string, now = Date.now()): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < now) return false;
    const expected = Buffer.from(this.sig(tenantId, photoId, size, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

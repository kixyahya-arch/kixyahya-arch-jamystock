import { Controller, Get, Inject, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { isClientRole } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from '../files/files.service.js';

const uuid = z.string().uuid();
const PHOTO_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const MAX_COLLECTION_PHOTOS = 10;
/** Tant que le chauffeur n'est pas passé, le client peut encore compléter sa demande en photos. */
const OUVERTE = ['EN_ATTENTE_VALIDATION', 'SOUMISE', 'PLANIFIEE'];

function looksLike(mime: string, b: Buffer): boolean {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 4).toString('hex') === '89504e47';
  if (mime === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  return false;
}

/**
 * CMD-06 : photos facultatives jointes à une demande de collecte, prises depuis le téléphone du client.
 * Elles aident le dispatch à choisir le véhicule et l'équipe ; le chauffeur et l'opérateur les voient sur la demande.
 */
@Controller('collections')
export class CollectionPhotosController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** Photo jointe (JPEG, PNG ou WebP, 4 Mo max), par le demandeur, tant que la collecte n'a pas eu lieu. */
  @Put(':id/photos/:photoId')
  @RequirePermission('collection.request')
  async put(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('photoId') pid: string, @Req() req: Request) {
    if (!isClientRole(user.role)) throw forbidden('Réservé aux comptes clients');
    const commandeId = uuid.parse(id);
    const photoId = uuid.parse(pid);
    const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = PHOTO_TYPES[mime];
    if (!ext) throw unprocessable('TYPE_MIME', 'Formats acceptés : JPEG, PNG, WebP');
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('VIDE', 'Fichier vide');
    if (!looksLike(mime, data)) throw unprocessable('TYPE_MIME', 'Le contenu ne correspond pas au type annoncé');
    // la demande doit être visible de l'utilisateur (RLS), et c'est la sienne
    const c = (
      await this.db.tx(ctxOf(user), (tx) => tx.query<{ type: string; statut: string; demandeur_id: string }>('SELECT type, statut, demandeur_id FROM commande WHERE id = $1', [commandeId]))
    ).rows[0];
    if (!c || c.type !== 'COLLECTE') throw notFound('Collecte');
    if (c.demandeur_id !== user.id) throw forbidden('Seul l’auteur de la demande ajoute des photos');
    if (!OUVERTE.includes(c.statut)) throw conflict('COLLECTE_FAITE', 'La collecte a déjà eu lieu');
    await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM photo WHERE commande_id = $1 AND id <> $2', [commandeId, photoId])).rows[0]!.n;
      if (n >= MAX_COLLECTION_PHOTOS) throw unprocessable('PHOTOS', `${MAX_COLLECTION_PHOTOS} photos au maximum`);
      const key = `${user.tenantId}/photos/${photoId}/original.${ext}`;
      await this.storage.put(key, data);
      // la photo rejoint la table des photos (liens signés) ; une photo déjà envoyée par un autre utilisateur n'est pas écrasée
      const r = await tx.query(
        `INSERT INTO photo (id, tenant_id, article_id, commande_id, cle_originale, contexte, prise_le, prise_par, televersee, type_mime, taille_octets)
         VALUES ($1,$2,NULL,$3,$4,'ENLEVEMENT',now(),$5,true,$6,$7)
         ON CONFLICT (id) DO UPDATE SET cle_originale = EXCLUDED.cle_originale, televersee = true, type_mime = EXCLUDED.type_mime, taille_octets = EXCLUDED.taille_octets
         WHERE photo.prise_par = EXCLUDED.prise_par AND photo.commande_id = EXCLUDED.commande_id`,
        [photoId, user.tenantId, commandeId, key, user.id, mime, data.length],
      );
      if (!r.rowCount) throw conflict('PHOTO_EXISTANTE', 'Cette photo existe déjà');
    });
    return { photoId, televersee: true };
  }

  /** Photos de la demande (client qui voit la demande, ou personnel). */
  @Get(':id/photos')
  @RequirePermission('inventory.read')
  async list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const commandeId = uuid.parse(id);
    const visible = await this.db.tx(ctxOf(user), (tx) => tx.query(`SELECT 1 FROM commande WHERE id = $1 AND type = 'COLLECTE'`, [commandeId]));
    if (!visible.rowCount) throw notFound('Collecte');
    return collectionPhotos(this.db, this.files, user.tenantId, commandeId);
  }
}

export async function collectionPhotos(db: Database, files: FilesService, tenantId: string, commandeId: string) {
  const r = await db.tx({ tenantId, role: 'SYSTEM' }, (tx) =>
    tx.query<{ id: string }>('SELECT id FROM photo WHERE commande_id = $1 AND televersee ORDER BY prise_le, id', [commandeId]),
  );
  return r.rows.map((p) => ({ id: p.id, ...files.photoUrls(tenantId, p.id) }));
}

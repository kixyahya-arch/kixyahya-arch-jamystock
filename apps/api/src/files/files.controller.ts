import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { Public } from '../auth/decorators.js';
import { BusinessError, notFound } from '../common/errors.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService, PHOTO_SIZES, type PhotoSize } from './files.service.js';

const TYPES: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml' };

/**
 * Tailles dérivées (INV-01 : vignette WebP ≤ 40 Ko). Générées à la première demande à partir de l'originale, puis
 * gardées : cela couvre d'un coup toutes les sources de photos (terrain, reprise, litiges) sans tâche de fond.
 */
const VARIANTS: Record<'t' | 'm', { px: number; quality: number; col: 'cle_vignette' | 'cle_moyenne' }> = {
  t: { px: 480, quality: 62, col: 'cle_vignette' },
  m: { px: 1200, quality: 78, col: 'cle_moyenne' },
};
const RASTER = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']);

const Q = z.object({ t: z.string().uuid(), e: z.coerce.number().int(), s: z.string().min(10).max(100) });

@Controller('files')
export class FilesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Photo par lien signé (vignette t, moyenne m, originale o). Repli sur la taille au-dessus si elle n'est pas générée. */
  @Public()
  @Get('photos/:id/:size')
  async photo(@Param('id') id: string, @Param('size') size: string, @Query() query: unknown, @Res() res: Response) {
    const photoId = z.string().uuid().parse(id);
    if (!PHOTO_SIZES.includes(size as PhotoSize)) throw notFound('Fichier');
    const q = Q.parse(query);
    if (!this.files.verify(q.t, photoId, size as PhotoSize, q.e, q.s)) throw new BusinessError(403, 'LIEN_INVALIDE', 'Lien expiré ou invalide');
    const row = await this.db.tx({ tenantId: q.t, role: 'SYSTEM' }, async (tx) => {
      const r = await tx.query<{ o: string; m: string | null; t: string | null; mime: string | null }>(
        `SELECT cle_originale AS o, cle_moyenne AS m, cle_vignette AS t, type_mime AS mime FROM photo WHERE id = $1 AND televersee`,
        [photoId],
      );
      return r.rows[0];
    });
    if (!row) throw notFound('Fichier');
    let key = size === 't' ? row.t : size === 'm' ? row.m : row.o;
    if (!key && (size === 't' || size === 'm')) key = await this.variant(q.t, photoId, row.o, size);
    key ??= size === 't' ? (row.m ?? row.o) : row.o;
    let data: Buffer;
    try {
      data = await this.storage.get(key);
    } catch {
      throw notFound('Fichier');
    }
    const ext = key.split('.').pop()!.toLowerCase();
    res.set({
      'Content-Type': TYPES[ext] ?? row.mime ?? 'application/octet-stream',
      'Cache-Control': `private, max-age=${Math.max(0, q.e - Math.floor(Date.now() / 1000))}`,
      'X-Content-Type-Options': 'nosniff',
      // une image servie seule ne doit jamais pouvoir exécuter de script (SVG compris)
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-site',
    });
    res.send(data);
  }

  /** Visuel d'aménagement d'une pièce de pack, par lien signé. */
  @Public()
  @Get('ambiances/:id')
  async ambiance(@Param('id') id: string, @Query() query: unknown, @Res() res: Response) {
    const ambId = z.string().uuid().parse(id);
    const q = Q.parse(query);
    if (!this.files.verify(q.t, ambId, 'a', q.e, q.s)) throw new BusinessError(403, 'LIEN_INVALIDE', 'Lien expiré ou invalide');
    const key = await this.db.tx({ tenantId: q.t, role: 'SYSTEM' }, async (tx) => (await tx.query<{ cle: string }>(`SELECT cle FROM pack_ambiance WHERE id = $1 AND statut = 'PRET' AND cle IS NOT NULL`, [ambId])).rows[0]?.cle);
    if (!key) throw notFound('Fichier');
    let data: Buffer;
    try {
      data = await this.storage.get(key);
    } catch {
      throw notFound('Fichier');
    }
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': `private, max-age=${Math.max(0, q.e - Math.floor(Date.now() / 1000))}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-site',
    });
    res.send(data);
  }

  /** Fabrique et enregistre une taille dérivée ; renvoie sa clé, ou null si l'originale n'est pas une image matricielle lisible. */
  private async variant(tenantId: string, photoId: string, original: string, size: 't' | 'm'): Promise<string | null> {
    const ext = original.split('.').pop()!.toLowerCase();
    if (!RASTER.has(ext)) return null;
    const v = VARIANTS[size];
    try {
      const data = await sharp(await this.storage.get(original), { failOn: 'none' })
        .rotate()
        .resize({ width: v.px, height: v.px, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: v.quality })
        .toBuffer();
      const key = `${original.replace(/\/[^/]*$/, '')}/${photoId}-${size}.webp`;
      await this.storage.put(key, data);
      // la même image peut servir plusieurs fiches (articles dupliqués) : toutes en profitent
      await this.db.tx({ tenantId, role: 'SYSTEM' }, (tx) => tx.query(`UPDATE photo SET ${v.col} = $2 WHERE cle_originale = $1 AND ${v.col} IS NULL`, [original, key]));
      return key;
    } catch {
      return null;
    }
  }
}

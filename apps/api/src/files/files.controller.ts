import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { Public } from '../auth/decorators.js';
import { BusinessError, notFound } from '../common/errors.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService, PHOTO_SIZES, type PhotoSize } from './files.service.js';

const TYPES: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml' };

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
    const key = size === 't' ? (row.t ?? row.m ?? row.o) : size === 'm' ? (row.m ?? row.o) : row.o;
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
}

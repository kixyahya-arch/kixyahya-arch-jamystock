import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ARTICLE_CONDITIONS, type SyncRequest } from '@jamystock/domain';
import { FieldService } from './field.service.js';
import { StorageService } from '../storage/storage.service.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { forbidden, unprocessable } from '../common/errors.js';
import { STAFF_ROLES } from '@jamystock/domain';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), precision: z.number().nonnegative().optional() });
const photos = z.array(z.object({ photoId: uuid })).max(20);
const signataire = z.object({ nom: z.string().max(200), qualite: z.string().max(200) });
const qr = z.string().min(3).max(200);

const Action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ARTICLE_CREATE'),
    payload: z.object({
      articleId: uuid, qr, entrepriseId: uuid.optional(), projetId: uuid.nullable().optional(), commandeId: uuid.nullable().optional(),
      libelle: z.string().min(1).max(300), categorieId: uuid.nullable().optional(), etat: z.enum(ARTICLE_CONDITIONS),
      description: z.string().max(5000).optional(), longueurM: z.number().positive().optional(), largeurM: z.number().positive().optional(),
      hauteurM: z.number().positive().optional(), poidsKg: z.number().nonnegative().optional(), empilable: z.boolean().optional(), photos,
    }),
  }),
  z.object({ type: z.literal('ARTICLE_STORE'), payload: z.object({ articleQr: qr, locationQr: qr, force: z.boolean().optional(), motif: z.string().max(1000).optional() }) }),
  z.object({ type: z.literal('TRANSFER'), payload: z.object({ qr, locationQr: qr, motif: z.string().max(1000).optional() }) }),
  z.object({
    type: z.literal('UM_CREATE'),
    payload: z.object({ umId: uuid, qr, umType: z.enum(['PALETTE', 'CAISSE', 'RACK']), entrepriseId: uuid.optional(), longueurM: z.number().positive().optional(), largeurM: z.number().positive().optional() }),
  }),
  z.object({ type: z.literal('UM_ADD'), payload: z.object({ umQr: qr, articleQr: qr }) }),
  z.object({ type: z.literal('UM_STORE'), payload: z.object({ umQr: qr, locationQr: qr, force: z.boolean().optional(), motif: z.string().max(1000).optional() }) }),
  z.object({ type: z.literal('RECEPTION_CLOSE'), payload: z.object({ commandeId: uuid }) }),
  z.object({ type: z.literal('RETURN'), payload: z.object({ articleQr: qr, locationQr: qr.optional(), motif: z.string().max(1000).optional() }) }),
  z.object({ type: z.literal('PICK'), payload: z.object({ missionId: uuid, articleQr: qr }) }),
  z.object({ type: z.literal('PICK_MISSING'), payload: z.object({ missionId: uuid, articleId: uuid, photoId: uuid.optional(), commentaire: z.string().max(1000).optional() }) }),
  z.object({ type: z.literal('PICK_COMPLETE'), payload: z.object({ missionId: uuid }) }),
  z.object({ type: z.literal('LOAD'), payload: z.object({ missionId: uuid, articleQr: qr }) }),
  z.object({ type: z.literal('DEPART'), payload: z.object({ missionId: uuid }) }),
  z.object({ type: z.literal('ARRIVE'), payload: z.object({ missionId: uuid, gps: gps.optional() }) }),
  z.object({
    type: z.literal('BL_SIGN'),
    payload: z.object({
      missionId: uuid, blId: uuid, livres: z.array(uuid).max(1000), refuses: z.array(uuid).max(1000),
      reserves: z.array(z.object({ articleId: uuid, type: z.enum(['CASSE', 'RAYURE', 'MANQUANT', 'REFUS', 'AUTRE']), commentaire: z.string().max(2000).optional(), photoIds: z.array(uuid).max(10).optional() })).max(1000),
      signataire, signatureSvg: z.string().max(500_000), signedAt: iso, gps: gps.optional(), empreinte: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
  z.object({
    type: z.literal('PICKUP_SIGN'),
    payload: z.object({
      missionId: uuid, blId: uuid,
      articles: z.array(z.object({ articleId: uuid, qr: qr.optional(), libelle: z.string().min(1).max(300), categorieId: uuid.nullable().optional(), photos })).max(1000),
      signataire, signatureSvg: z.string().max(500_000), signedAt: iso, gps: gps.optional(), empreinte: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
]);

const SyncBody = z.object({
  deviceId: z.string().min(1).max(200),
  deviceTime: iso,
  actions: z.array(z.object({ key: z.string().min(8).max(200), at: iso, action: Action })).max(500),
});

const PHOTO_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

@Controller('field')
export class FieldController {
  constructor(
    @Inject(FieldService) private readonly field: FieldService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  private staffOnly(user: AuthUser) {
    if (!STAFF_ROLES.includes(user.role)) throw forbidden('Réservé au personnel terrain');
  }

  /** File d'actions hors-ligne (§7.5). Chaque action déclare sa propre permission. */
  @Post('sync')
  @HttpCode(200)
  sync(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.staffOnly(user);
    return this.field.sync(user, SyncBody.parse(body) as SyncRequest);
  }

  @Get('receptions')
  @RequirePermission('stock.move')
  receptions(@CurrentUser() user: AuthUser) {
    return this.field.expectedReceptions(user);
  }

  @Get('missions/:id')
  missionDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.staffOnly(user);
    return this.field.missionDetail(user, uuid.parse(id));
  }

  /** Binaire d'une photo (WebP compressé sur le terminal, ≤ 400 Ko visé ; 2 Mo max accepté). */
  @Put('photos/:id')
  @RequirePermission('stock.move')
  async uploadPhoto(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const photoId = uuid.parse(id);
    const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = PHOTO_TYPES[mime];
    if (!ext) throw unprocessable('TYPE_MIME', 'Formats acceptés : WebP, JPEG, PNG');
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('VIDE', 'Fichier vide');
    if (!looksLike(mime, data)) throw unprocessable('TYPE_MIME', 'Le contenu ne correspond pas au type annoncé');
    const key = `${user.tenantId}/photos/${photoId}/original.${ext}`;
    await this.storage.put(key, data);
    return this.field.photoUploaded(user, photoId, key, mime, data.length);
  }
}

/** Contrôle du type par signature binaire (§7.3 : contrôle du type MIME). */
function looksLike(mime: string, b: Buffer): boolean {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 4).toString('hex') === '89504e47';
  if (mime === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  return false;
}

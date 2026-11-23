import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Logger, OnModuleDestroy, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { isClientRole, normalizePiece, uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { dims, PacksService, type PackRow } from './packs.controller.js';
import { ambiancePrompt, HiggsfieldClient, HiggsfieldError } from './higgsfield.js';
import { PollinationsClient } from './pollinations.js';

/**
 * Visuels d'aménagement (compte rendu Adam du 21/11) : pour chaque pièce d'un pack, une image de la pièce meublée,
 * en tête de la pièce sur la page du pack et dans la planche PDF. Deux sources :
 *  - IA : Pollinations (gratuit) ou Higgsfield (payant) génère la pièce à partir de la liste des meubles (et, pour
 *    Higgsfield, de leurs photos si le modèle en accepte) ; la génération tourne en tâche de fond, la page du pack
 *    se met à jour d'elle-même ;
 *  - MANUEL : une image ajoutée à la main (photo de l'appartement témoin, rendu d'un architecte).
 * Un plafond mensuel par client et pour l'organisation protège le solde Higgsfield et l'accès gratuit à Pollinations.
 */

const uuid = z.string().uuid();
const PieceBody = z.object({ piece: z.string().trim().min(1).max(80) });
const PieceQuery = z.object({ piece: z.string().trim().min(1).max(80) });
const MAX_REFERENCES = 4;

interface Job {
  id: string;
  m: PackRow;
  piece: string;
  keys: string[];
  biens: { libelle: string; dimensions: string | null }[];
}

@Injectable()
export class AmbiancesService implements OnModuleDestroy {
  private readonly log = new Logger('Ambiances');
  private readonly client: HiggsfieldClient;
  private readonly pollinations: PollinationsClient;
  private readonly fournisseur: AppConfig['visuels'];
  private readonly running = new Set<Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PacksService) private readonly packs: PacksService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.client = new HiggsfieldClient(config.higgsfield);
    this.pollinations = new PollinationsClient(config.pollinations);
    this.fournisseur = config.visuels;
  }

  /** Tests : attend la fin des générations lancées. */
  async idle() {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  async onModuleDestroy() {
    await this.idle();
  }

  /** La pièce doit exister dans le pack (au moins un bien y est placé). */
  private pieceOf(m: PackRow, raw: string): string {
    const piece = normalizePiece(raw);
    if (!piece || !Object.values(m.pieces ?? {}).includes(piece)) throw unprocessable('PIECE_INCONNUE', 'Placez d’abord des biens dans cette pièce');
    return piece;
  }

  private canEdit(user: AuthUser, m: PackRow) {
    if (user.role === 'B2B_USER' && m.cree_par !== user.id) throw forbidden('Seul son auteur ou un administrateur modifie un pack');
  }

  /** Les visuels plus anciens de la pièce sont retirés ; renvoie leurs fichiers. */
  private async supersede(tx: Tx, packId: string, piece: string, keep: string): Promise<string[]> {
    const r = await tx.query<{ cle: string | null }>(
      `UPDATE pack_ambiance SET statut = 'SUPPRIME', termine_le = coalesce(termine_le, now())
        WHERE pack_id = $1 AND piece = $2 AND id <> $3 AND statut IN ('PRET', 'ECHEC') RETURNING cle`,
      [packId, piece, keep],
    );
    return r.rows.map((x) => x.cle).filter((x): x is string => !!x);
  }

  async generate(user: AuthUser, packId: string, rawPiece: string) {
    if (!this.fournisseur) throw unprocessable('IA_INACTIVE', 'La génération de visuels n’est pas encore activée : ajoutez une image à la main');
    const job = await this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, packId, true);
      this.canEdit(user, m);
      const piece = this.pieceOf(m, rawPiece);
      const busy = await tx.query(`SELECT 1 FROM pack_ambiance WHERE pack_id = $1 AND piece = $2 AND statut = 'EN_COURS' AND created_at > now() - interval '10 minutes'`, [m.id, piece]);
      if (busy.rowCount) throw conflict('GENERATION_EN_COURS', 'Un visuel de cette pièce est déjà en cours de génération');
      if ((await this.packs.quota(user.tenantId, m.entreprise_id)) <= 0) throw unprocessable('PLAFOND_ATTEINT', 'Plafond de visuels générés atteint pour ce mois-ci');
      const ids = m.article_ids.filter((aid) => m.pieces?.[aid] === piece);
      const all = await this.packs.articles(tx, ids);
      const biens = ids.map((aid) => all.get(aid)).filter((a) => !!a);
      const photoIds = biens.map((a) => a.photo).filter((x): x is string => !!x).slice(0, MAX_REFERENCES);
      const keys = photoIds.length
        ? (await tx.query<{ cle: string }>('SELECT coalesce(cle_moyenne, cle_originale) AS cle FROM photo WHERE id = ANY($1::uuid[])', [photoIds])).rows.map((r) => r.cle)
        : [];
      const id = uuidv7();
      await tx.query(
        `INSERT INTO pack_ambiance (id, tenant_id, pack_id, entreprise_id, projet_id, piece, source, statut, cree_par) VALUES ($1,$2,$3,$4,$5,$6,'IA','EN_COURS',$7)`,
        [id, user.tenantId, m.id, m.entreprise_id, m.projet_id, piece, user.id],
      );
      await this.audit.record(tx, user, { action: 'VISUEL_IA_DEMANDE', objet: 'modele_panier', objetId: m.id, entrepriseId: m.entreprise_id, apres: { piece, biens: biens.length } });
      return { id, m, piece, keys, biens: biens.map((a) => ({ libelle: a.libelle, dimensions: dims(a) })) };
    });
    const p = this.run(user.tenantId, job).finally(() => this.running.delete(p));
    this.running.add(p);
    return { id: job.id, piece: job.piece, statut: 'EN_COURS' as const };
  }

  /** Génération en tâche de fond, puis enregistrement de l'image. */
  private async run(tenantId: string, job: Job) {
    const sys = { tenantId, role: 'SYSTEM' as const };
    try {
      const raw = this.fournisseur === 'pollinations' ? await this.viaPollinations(sys, job) : await this.viaHiggsfield(sys, job);
      const jpeg = await sharp(raw, { failOn: 'none' }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      const key = `${tenantId}/ambiances/${job.id}.jpg`;
      await this.storage.put(key, jpeg);
      const old = await this.db.tx(sys, async (tx) => {
        const r = await tx.query(`UPDATE pack_ambiance SET statut = 'PRET', cle = $2, termine_le = now() WHERE id = $1 AND statut = 'EN_COURS'`, [job.id, key]);
        if (!r.rowCount) return [key]; // retiré pendant la génération
        return this.supersede(tx, job.m.id, job.piece, job.id);
      });
      for (const k of old) await this.storage.remove(k).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof HiggsfieldError ? e.message : 'Erreur inattendue pendant la génération';
      if (!(e instanceof HiggsfieldError)) this.log.error(`Visuel ${job.id} : ${(e as Error).message}`);
      await this.db
        .tx(sys, (tx) => tx.query(`UPDATE pack_ambiance SET statut = 'ECHEC', erreur = $2, termine_le = now() WHERE id = $1 AND statut = 'EN_COURS'`, [job.id, msg.slice(0, 300)]))
        .catch(() => undefined);
    }
  }

  /** Pollinations : la description des meubles suffit, l'image revient directement. */
  private async viaPollinations(sys: { tenantId: string; role: 'SYSTEM' }, job: Job): Promise<Buffer> {
    const prompt = ambiancePrompt({ piece: job.piece, description: job.m.description, biens: job.biens, references: 0, court: true });
    await this.db.tx(sys, (tx) => tx.query('UPDATE pack_ambiance SET request_id = $2 WHERE id = $1', [job.id, 'pollinations']));
    return this.pollinations.generate(prompt);
  }

  /** Higgsfield : photos de référence, requête, suivi, téléchargement. */
  private async viaHiggsfield(sys: { tenantId: string; role: 'SYSTEM' }, job: Job): Promise<Buffer> {
    const refs: string[] = [];
    if (this.client.usesReferences) {
      for (const k of job.keys) {
        const jpeg = await this.storage
          .get(k)
          .then((b) => sharp(b, { failOn: 'none' }).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer())
          .catch(() => null);
        if (jpeg) refs.push(await this.client.upload(jpeg));
      }
    }
    const prompt = ambiancePrompt({ piece: job.piece, description: job.m.description, biens: job.biens, references: refs.length });
    const { requestId, statusUrl } = await this.client.submit(this.client.body(prompt, refs), job.id);
    await this.db.tx(sys, (tx) => tx.query('UPDATE pack_ambiance SET request_id = $2 WHERE id = $1', [job.id, requestId]));
    const url = await this.client.wait(statusUrl);
    return this.client.download(url);
  }

  /**
   * Description de la pièce à coller dans Higgsfield (ou tout autre générateur) avec les photos des meubles :
   * l'image produite est ensuite ajoutée à la main. Ne coûte rien et ne compte pas dans le plafond.
   */
  async brief(user: AuthUser, packId: string, rawPiece: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, packId);
      const piece = this.pieceOf(m, rawPiece);
      const ids = m.article_ids.filter((aid) => m.pieces?.[aid] === piece);
      const all = await this.packs.articles(tx, ids);
      const biens = ids.map((aid) => all.get(aid)).filter((a) => !!a);
      const photos = biens.filter((a) => !!a.photo).length;
      return { piece, prompt: ambiancePrompt({ piece, description: m.description, biens: biens.map((a) => ({ libelle: a.libelle, dimensions: dims(a) })), references: photos }) };
    });
  }

  /** Image ajoutée à la main (JPEG, PNG ou WebP, 8 Mo max) ; remplace le visuel de la pièce. */
  async upload(user: AuthUser, packId: string, rawPiece: string, req: Request) {
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('VIDE', 'Fichier vide ou format non accepté (JPEG, PNG, WebP)');
    let jpeg: Buffer;
    try {
      jpeg = await sharp(data).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    } catch {
      throw unprocessable('TYPE_MIME', 'Image illisible : formats acceptés JPEG, PNG, WebP');
    }
    const id = uuidv7();
    const key = `${user.tenantId}/ambiances/${id}.jpg`;
    await this.storage.put(key, jpeg);
    try {
      const old = await this.db.tx(ctxOf(user), async (tx) => {
        const m = await this.packs.load(tx, packId, true);
        this.canEdit(user, m);
        const piece = this.pieceOf(m, rawPiece);
        await tx.query(
          `INSERT INTO pack_ambiance (id, tenant_id, pack_id, entreprise_id, projet_id, piece, source, statut, cle, cree_par, termine_le) VALUES ($1,$2,$3,$4,$5,$6,'MANUEL','PRET',$7,$8,now())`,
          [id, user.tenantId, m.id, m.entreprise_id, m.projet_id, piece, key, user.id],
        );
        // une génération en cours pour la pièce est abandonnée : l'image ajoutée prime
        await tx.query(`UPDATE pack_ambiance SET statut = 'SUPPRIME', termine_le = now() WHERE pack_id = $1 AND piece = $2 AND statut = 'EN_COURS'`, [m.id, piece]);
        return this.supersede(tx, m.id, piece, id);
      });
      for (const k of old) await this.storage.remove(k).catch(() => undefined);
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
    return { id, statut: 'PRET' as const };
  }

  /** Retire le visuel de la pièce (et abandonne une génération en cours). */
  async remove(user: AuthUser, packId: string, rawPiece: string) {
    const keys = await this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, packId, true);
      this.canEdit(user, m);
      const piece = normalizePiece(rawPiece);
      if (!piece) throw notFound('Pièce');
      const r = await tx.query<{ cle: string | null }>(
        `UPDATE pack_ambiance SET statut = 'SUPPRIME', termine_le = coalesce(termine_le, now()) WHERE pack_id = $1 AND piece = $2 AND statut <> 'SUPPRIME' RETURNING cle`,
        [m.id, piece],
      );
      return r.rows.map((x) => x.cle).filter((x): x is string => !!x);
    });
    for (const k of keys) await this.storage.remove(k).catch(() => undefined);
    return { supprime: true };
  }
}

const clientOnly = (user: AuthUser) => {
  if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
};

/** Espace Client : visuels des pièces de ses packs. */
@Controller('me/cart-templates/:id/ambiances')
export class PackAmbiancesController {
  constructor(@Inject(AmbiancesService) private readonly ambiances: AmbiancesService) {}

  @Get('brief')
  @RequirePermission('order.create')
  brief(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown) {
    clientOnly(user);
    return this.ambiances.brief(user, uuid.parse(id), PieceQuery.parse(q).piece);
  }

  @Post('ia')
  @HttpCode(202)
  @RequirePermission('order.create')
  generate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    clientOnly(user);
    return this.ambiances.generate(user, uuid.parse(id), PieceBody.parse(body).piece);
  }

  @Put()
  @RequirePermission('order.create')
  upload(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown, @Req() req: Request) {
    clientOnly(user);
    return this.ambiances.upload(user, uuid.parse(id), PieceQuery.parse(q).piece, req);
  }

  @Delete()
  @RequirePermission('order.create')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown) {
    clientOnly(user);
    return this.ambiances.remove(user, uuid.parse(id), PieceQuery.parse(q).piece);
  }
}

/** Back-Office : les mêmes visuels, pour les packs composés pour un client. */
@Controller('bo/packs/:id/ambiances')
export class BoPackAmbiancesController {
  constructor(@Inject(AmbiancesService) private readonly ambiances: AmbiancesService) {}

  @Get('brief')
  @RequirePermission('client.manage')
  brief(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown) {
    return this.ambiances.brief(user, uuid.parse(id), PieceQuery.parse(q).piece);
  }

  @Post('ia')
  @HttpCode(202)
  @RequirePermission('client.manage')
  generate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.ambiances.generate(user, uuid.parse(id), PieceBody.parse(body).piece);
  }

  @Put()
  @RequirePermission('client.manage')
  upload(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown, @Req() req: Request) {
    return this.ambiances.upload(user, uuid.parse(id), PieceQuery.parse(q).piece, req);
  }

  @Delete()
  @RequirePermission('client.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: unknown) {
    return this.ambiances.remove(user, uuid.parse(id), PieceQuery.parse(q).piece);
  }
}

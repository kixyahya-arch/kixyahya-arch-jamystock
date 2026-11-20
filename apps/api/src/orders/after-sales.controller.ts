import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { formatDocumentNumber, isClientRole, uuidv7 } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from './orders.service.js';

const uuid = z.string().uuid();
const clientOnly = (user: AuthUser) => {
  if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
};

// =====================================================================================
// CMD-08 : modèles de panier
// =====================================================================================

const TemplateBody = z.object({
  nom: z.string().trim().min(1, 'Donnez un nom au modèle').max(80),
  projetId: uuid.optional(),
  /** à défaut, le contenu du panier en cours */
  articleIds: z.array(uuid).min(1).max(500).optional(),
});

/** Raison pour laquelle un article d'un modèle ne peut pas être recommandé maintenant. */
const UNAVAILABLE: Record<string, string> = {
  RESERVE: 'déjà dans une autre commande',
  EN_PREPARATION: 'en préparation pour une autre commande',
  EN_TRANSIT: 'en cours de livraison',
  RESTITUE: 'déjà livré, plus au dépôt',
  ATTENDU: 'pas encore arrivé au dépôt',
  EN_RECEPTION: 'en cours de réception',
  PERDU: 'déclaré perdu',
  DETRUIT: 'détruit',
};

interface TemplateArticle {
  id: string;
  libelle: string | null;
  statut: string | null;
  engage: boolean;
}

@Controller('me/cart-templates')
export class CartTemplatesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /** Articles d'un modèle, vus avec les droits de l'utilisateur : un article qu'il ne voit plus est indisponible. */
  private async articles(tx: Tx, ids: string[]): Promise<Map<string, TemplateArticle>> {
    const r = await tx.query<TemplateArticle>(
      `SELECT a.id, coalesce(a.nom_client, a.libelle) AS libelle, a.statut,
              EXISTS (SELECT 1 FROM ligne_commande l WHERE l.article_id = a.id AND l.active) AS engage
         FROM article a WHERE a.id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(r.rows.map((a) => [a.id, a]));
  }

  private status(a: TemplateArticle | undefined): string | null {
    if (!a) return 'n’est plus accessible';
    if (a.statut === 'EN_STOCK' && !a.engage) return null;
    if (a.statut === 'EN_STOCK') return 'déjà dans une autre commande';
    return UNAVAILABLE[a.statut ?? ''] ?? 'indisponible';
  }

  @Get()
  @RequirePermission('order.create')
  list(@CurrentUser() user: AuthUser) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<{ id: string; nom: string; projet_id: string | null; projet: string | null; article_ids: string[]; cree_par: string; auteur: string | null; created_at: Date; utilise_le: Date | null }>(
        `SELECT m.id, m.nom, m.projet_id, p.nom AS projet, m.article_ids, m.cree_par, u.nom AS auteur, m.created_at, m.utilise_le
           FROM modele_panier m LEFT JOIN projet p ON p.id = m.projet_id LEFT JOIN utilisateur u ON u.id = m.cree_par
          ORDER BY coalesce(m.utilise_le, m.created_at) DESC`,
      );
      const all = await this.articles(tx, [...new Set(r.rows.flatMap((m) => m.article_ids))]);
      return {
        items: r.rows.map((m) => ({
          id: m.id,
          nom: m.nom,
          projetId: m.projet_id,
          projet: m.projet,
          auteur: m.auteur,
          creeLe: m.created_at,
          utiliseLe: m.utilise_le,
          nbArticles: m.article_ids.length,
          nbDisponibles: m.article_ids.filter((id) => !this.status(all.get(id))).length,
          supprimable: m.cree_par === user.id || user.role !== 'B2B_USER',
        })),
      };
    });
  }

  @Post()
  @RequirePermission('order.create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    clientOnly(user);
    const b = TemplateBody.parse(body);
    if (user.role === 'B2B_USER' && !b.projetId) throw unprocessable('PROJET_REQUIS', 'Un modèle d’utilisateur B2B se rattache à un projet');
    return this.db.tx(ctxOf(user), async (tx) => {
      let ids = b.articleIds;
      if (!ids) {
        const cart = await tx.query<{ article_id: string }>(
          `SELECT l.article_id FROM ligne_commande l JOIN commande c ON c.id = l.commande_id
            WHERE c.demandeur_id = $1 AND c.statut = 'BROUILLON' AND c.type <> 'COLLECTE' AND l.article_id IS NOT NULL
              AND c.projet_id IS NOT DISTINCT FROM $2::uuid`,
          [user.id, b.projetId ?? null],
        );
        ids = cart.rows.map((x) => x.article_id);
      }
      if (!ids.length) throw unprocessable('PANIER_VIDE', 'Le panier est vide : ajoutez des biens avant de l’enregistrer comme modèle');
      const visible = await this.articles(tx, ids);
      if (visible.size !== new Set(ids).size) throw notFound('Article');
      const dup = await tx.query('SELECT 1 FROM modele_panier WHERE lower(nom) = lower($1) AND projet_id IS NOT DISTINCT FROM $2::uuid', [b.nom, b.projetId ?? null]);
      if (dup.rowCount) throw conflict('NOM_PRIS', 'Un modèle porte déjà ce nom');
      const id = uuidv7();
      await tx.query(
        `INSERT INTO modele_panier (id, tenant_id, entreprise_id, projet_id, nom, article_ids, cree_par) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, user.tenantId, user.entrepriseId, b.projetId ?? null, b.nom, [...new Set(ids)], user.id],
      );
      return { id, nom: b.nom, nbArticles: new Set(ids).size };
    });
  }

  /** Détail : chaque article avec sa disponibilité du moment. */
  @Get(':id')
  @RequirePermission('order.create')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = (await tx.query<{ id: string; nom: string; projet_id: string | null; article_ids: string[] }>('SELECT id, nom, projet_id, article_ids FROM modele_panier WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!m) throw notFound('Modèle');
      const all = await this.articles(tx, m.article_ids);
      return {
        id: m.id,
        nom: m.nom,
        projetId: m.projet_id,
        articles: m.article_ids.map((aid) => ({ id: aid, libelle: all.get(aid)?.libelle ?? 'Bien retiré de votre périmètre', indisponible: this.status(all.get(aid)) })),
      };
    });
  }

  /** Recommander : les articles disponibles vont au panier, les autres sont signalés. */
  @Post(':id/use')
  @HttpCode(200)
  @RequirePermission('order.create')
  async use(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    clientOnly(user);
    const { m, ready, missing } = await this.db.tx(ctxOf(user), async (tx) => {
      const m = (await tx.query<{ id: string; nom: string; projet_id: string | null; article_ids: string[] }>('SELECT id, nom, projet_id, article_ids FROM modele_panier WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!m) throw notFound('Modèle');
      const all = await this.articles(tx, m.article_ids);
      // déjà dans mon panier : ni ajouté ni signalé
      const mine = new Set(
        (
          await tx.query<{ article_id: string }>(
            `SELECT l.article_id FROM ligne_commande l JOIN commande c ON c.id = l.commande_id
              WHERE c.demandeur_id = $1 AND c.statut = 'BROUILLON' AND l.article_id = ANY($2::uuid[])`,
            [user.id, m.article_ids],
          )
        ).rows.map((x) => x.article_id),
      );
      const ready: string[] = [];
      const missing: { id: string; libelle: string; raison: string }[] = [];
      for (const aid of m.article_ids) {
        if (mine.has(aid)) continue;
        const reason = this.status(all.get(aid));
        if (reason) missing.push({ id: aid, libelle: all.get(aid)?.libelle ?? 'Bien', raison: reason });
        else ready.push(aid);
      }
      await tx.query('UPDATE modele_panier SET utilise_le = now() WHERE id = $1', [m.id]);
      return { m, ready, missing };
    });
    if (ready.length) await this.orders.addToCart(user, ready, m.projet_id ?? undefined);
    return { ajoutes: ready.length, indisponibles: missing, projetId: m.projet_id };
  }

  @Delete(':id')
  @RequirePermission('order.create')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = (await tx.query<{ cree_par: string }>('SELECT cree_par FROM modele_panier WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!m) throw notFound('Modèle');
      if (user.role === 'B2B_USER' && m.cree_par !== user.id) throw forbidden('Seul son auteur ou un administrateur supprime un modèle');
      await tx.query('DELETE FROM modele_panier WHERE id = $1', [uuid.parse(id)]);
      return { supprime: true };
    });
  }
}

// =====================================================================================
// SUI-04 : réserves et litiges après livraison
// =====================================================================================

/** Délai pour signaler un problème après la livraison. */
export const DISPUTE_WINDOW_HOURS = 48;
const MAX_DISPUTE_PHOTOS = 6;
const MOTIFS = ['CASSE', 'RAYURE', 'MANQUANT', 'ERREUR', 'AUTRE'] as const;

const DisputeBody = z.object({
  commandeId: uuid,
  motif: z.enum(MOTIFS),
  description: z.string().trim().min(10, 'Décrivez le problème (10 caractères minimum)').max(3000),
  articleIds: z.array(uuid).max(500).default([]),
});

const ResolveBody = z.object({
  statut: z.enum(['EN_COURS', 'RESOLU', 'REJETE']),
  reponse: z.string().trim().min(3).max(3000),
  gesteCents: z.number().int().min(0).max(10_000_00).optional(),
});

const PHOTO_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
function looksLike(mime: string, b: Buffer): boolean {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 4).toString('hex') === '89504e47';
  if (mime === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  return false;
}

interface DisputeRow {
  id: string;
  numero: string;
  entreprise_id: string;
  commande_id: string;
  bl_id: string;
  motif: string;
  description: string;
  article_ids: string[];
  photos: string[];
  statut: string;
  reponse: string | null;
  geste_cents: number | null;
  cree_par: string;
  created_at: Date;
  traite_le: Date | null;
}

/** Détail d'un litige, avec les liens signés de ses photos. */
async function presentDispute(tx: Tx, files: FilesService, tenantId: string, d: DisputeRow) {
  const extra = (
    await tx.query<{ bl: string; commande: string | null; client: string; projet: string | null; auteur: string | null; traite_par: string | null }>(
      `SELECT b.numero AS bl, c.numero AS commande, e.nom AS client, p.nom AS projet, u.nom AS auteur, t.nom AS traite_par
         FROM litige l JOIN bon_de_livraison b ON b.id = l.bl_id JOIN commande c ON c.id = l.commande_id JOIN entreprise e ON e.id = l.entreprise_id
         LEFT JOIN projet p ON p.id = l.projet_id LEFT JOIN utilisateur u ON u.id = l.cree_par LEFT JOIN utilisateur t ON t.id = l.traite_par
        WHERE l.id = $1`,
      [d.id],
    )
  ).rows[0];
  const arts = d.article_ids.length
    ? (await tx.query<{ id: string; libelle: string; qr_code: string }>('SELECT id, coalesce(nom_client, libelle) AS libelle, qr_code FROM article WHERE id = ANY($1::uuid[])', [d.article_ids])).rows
    : [];
  return {
    id: d.id,
    numero: d.numero,
    commandeId: d.commande_id,
    commande: extra?.commande ?? null,
    bl: extra?.bl ?? null,
    client: extra?.client ?? null,
    projet: extra?.projet ?? null,
    auteur: extra?.auteur ?? null,
    motif: d.motif,
    description: d.description,
    articles: arts.map((a) => ({ id: a.id, libelle: a.libelle, qrCode: a.qr_code })),
    // une photo n'entre dans la liste qu'une fois son fichier reçu
    photos: d.photos.map((p) => ({ id: p, ...files.photoUrls(tenantId, p) })),
    statut: d.statut,
    reponse: d.reponse,
    gesteCents: d.geste_cents,
    creeLe: d.created_at,
    traiteLe: d.traite_le,
    traitePar: extra?.traite_par ?? null,
  };
}

@Controller('me/disputes')
export class DisputesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Signaler un problème sur une livraison, dans les 48 heures suivant la remise (BL signé ou dépôt sans signature). */
  @Post()
  @RequirePermission('inventory.read')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    clientOnly(user);
    const b = DisputeBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const bl = (
        await tx.query<{ id: string; numero: string; signe_le: Date | null; entreprise_id: string; projet_id: string | null; numero_commande: string | null; contenu: { livres?: string[] } }>(
          `SELECT b.id, b.numero, b.signe_le, b.entreprise_id, c.projet_id, c.numero AS numero_commande, b.contenu
             FROM bon_de_livraison b JOIN commande c ON c.id = b.commande_id
            WHERE b.commande_id = $1 AND b.type IN ('LIVRAISON','RETRAIT') AND b.statut IN ('SIGNE','NON_SIGNE_DEPOSE','SCELLE')
            ORDER BY b.signe_le DESC LIMIT 1`,
          [b.commandeId],
        )
      ).rows[0];
      if (!bl) throw notFound('Livraison');
      const deadline = (bl.signe_le?.getTime() ?? 0) + DISPUTE_WINDOW_HOURS * 3600_000;
      if (Date.now() > deadline) throw conflict('DELAI_DEPASSE', `Un problème se signale dans les ${DISPUTE_WINDOW_HOURS} heures suivant la livraison : contactez-nous directement`);
      const delivered = new Set(bl.contenu?.livres ?? []);
      if (b.articleIds.some((a) => !delivered.has(a))) throw unprocessable('HORS_LIVRAISON', 'Un des biens choisis ne fait pas partie de cette livraison');
      const open = await tx.query(`SELECT numero FROM litige WHERE bl_id = $1 AND statut IN ('OUVERT','EN_COURS')`, [bl.id]);
      if (open.rowCount) throw conflict('LITIGE_EN_COURS', `Un signalement est déjà en cours sur cette livraison (${(open.rows[0] as { numero: string }).numero}) : complétez-le`);
      const now = new Date();
      const year = now.getUTCFullYear();
      const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [user.tenantId, 'LIT', year])).rows[0]!.n;
      const id = uuidv7();
      const numero = formatDocumentNumber('LIT', year, seq);
      await tx.query(
        `INSERT INTO litige (id, tenant_id, numero, entreprise_id, projet_id, commande_id, bl_id, motif, description, article_ids, cree_par)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, user.tenantId, numero, bl.entreprise_id, bl.projet_id, b.commandeId, bl.id, b.motif, b.description, b.articleIds, user.id],
      );
      await this.audit.record(tx, user, { action: 'LITIGE_OUVERT', objet: 'litige', objetId: id, entrepriseId: bl.entreprise_id, apres: { numero, bl: bl.numero, motif: b.motif } });
      await NotificationsService.enqueue(tx, user.tenantId, { modele: 'LITIGE_RECU', destinataireId: user.id, variables: { litige: numero, commandeId: b.commandeId, numero: bl.numero_commande } });
      return { id, numero, photosMax: MAX_DISPUTE_PHOTOS };
    }).then(async (r) => {
      // le personnel est prévenu hors de la RLS client (il ne voit pas les utilisateurs de l'exploitant)
      await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) =>
        tx.query(
          `INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables)
           SELECT gen_random_uuid(), $1, u.id, 'IN_APP', 'LITIGE_OUVERT', $2 FROM utilisateur u
            WHERE u.tenant_id = $1 AND u.role IN ('DISPATCHER','SUPER_ADMIN') AND u.statut = 'ACTIF'`,
          [user.tenantId, JSON.stringify({ litigeId: r.id, numero: r.numero, commandeId: b.commandeId })],
        ),
      );
      return r;
    });
  }

  /** Photo jointe (JPEG, PNG ou WebP, 2 Mo max), tant que le litige est ouvert. */
  @Put(':id/photos/:photoId')
  @RequirePermission('inventory.read')
  async photo(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('photoId') pid: string, @Req() req: Request) {
    clientOnly(user);
    const litigeId = uuid.parse(id);
    const photoId = uuid.parse(pid);
    const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = PHOTO_TYPES[mime];
    if (!ext) throw unprocessable('TYPE_MIME', 'Formats acceptés : JPEG, PNG, WebP');
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('VIDE', 'Fichier vide');
    if (!looksLike(mime, data)) throw unprocessable('TYPE_MIME', 'Le contenu ne correspond pas au type annoncé');
    const d = (await this.db.tx(ctxOf(user), (tx) => tx.query<DisputeRow>('SELECT * FROM litige WHERE id = $1', [litigeId]))).rows[0];
    if (!d) throw notFound('Signalement');
    if (d.cree_par !== user.id) throw forbidden('Seul l’auteur du signalement ajoute des photos');
    if (d.statut !== 'OUVERT') throw conflict('LITIGE_TRAITE', 'Ce signalement est déjà pris en charge');
    if (!d.photos.includes(photoId) && d.photos.length >= MAX_DISPUTE_PHOTOS) throw unprocessable('PHOTOS', `${MAX_DISPUTE_PHOTOS} photos au maximum`);
    const key = `${user.tenantId}/photos/${photoId}/original.${ext}`;
    await this.storage.put(key, data);
    // la photo rejoint la table des photos (liens signés) ; le client n'écrit pas directement cette table
    await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      await tx.query(
        `INSERT INTO photo (id, tenant_id, article_id, bl_id, cle_originale, contexte, prise_le, prise_par, televersee, type_mime, taille_octets)
         VALUES ($1,$2,NULL,$3,$4,'RESERVE',now(),$5,true,$6,$7)
         ON CONFLICT (id) DO UPDATE SET cle_originale = EXCLUDED.cle_originale, televersee = true, type_mime = EXCLUDED.type_mime, taille_octets = EXCLUDED.taille_octets
         WHERE photo.prise_par = EXCLUDED.prise_par`,
        [photoId, user.tenantId, d.bl_id, key, user.id, mime, data.length],
      );
      await tx.query(`UPDATE litige SET photos = photos || to_jsonb($2::text) WHERE id = $1 AND NOT photos ? $2`, [litigeId, photoId]);
    });
    return { photoId, televersee: true };
  }

  /** Remise d'une commande : BL, dépôt sans signature et ses photos, délai pour signaler un problème, signalements. */
  @Get('delivery/:commandeId')
  @RequirePermission('inventory.read')
  delivery(@CurrentUser() user: AuthUser, @Param('commandeId') commandeId: string) {
    clientOnly(user);
    const cid = uuid.parse(commandeId);
    return this.db.tx(ctxOf(user), async (tx) => {
      const bl = (
        await tx.query<{ id: string; numero: string; statut: string; signe_le: Date | null; lieu_depot: string | null; signataire_nom: string | null; livres: string[] | null }>(
          `SELECT b.id, b.numero, b.statut, b.signe_le, b.lieu_depot, b.signataire_nom,
                  ARRAY(SELECT jsonb_array_elements_text(b.contenu->'livres')) AS livres
             FROM bon_de_livraison b
            WHERE b.commande_id = $1 AND b.type IN ('LIVRAISON','RETRAIT') AND b.statut IN ('SIGNE','NON_SIGNE_DEPOSE','SCELLE')
            ORDER BY b.signe_le DESC LIMIT 1`,
          [cid],
        )
      ).rows[0];
      if (!bl) return { livraison: null, litiges: [] };
      // photos du dépôt : lues en contexte système (la table des photos d'un BL n'est pas exposée au client)
      const photos = bl.statut === 'NON_SIGNE_DEPOSE'
        ? (await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (s) => s.query<{ id: string }>(`SELECT id FROM photo WHERE bl_id = $1 AND contexte = 'DEPOT' AND televersee ORDER BY prise_le`, [bl.id]))).rows
        : [];
      const arts = bl.livres?.length
        ? (await tx.query<{ id: string; libelle: string }>('SELECT id, coalesce(nom_client, libelle) AS libelle FROM article WHERE id = ANY($1::uuid[]) ORDER BY 2', [bl.livres])).rows
        : [];
      const until = bl.signe_le ? new Date(bl.signe_le.getTime() + DISPUTE_WINDOW_HOURS * 3600_000) : null;
      const r = await tx.query<DisputeRow>('SELECT * FROM litige WHERE commande_id = $1 ORDER BY created_at DESC', [cid]);
      const litiges = [];
      for (const d of r.rows) litiges.push(await presentDispute(tx, this.files, user.tenantId, d));
      return {
        livraison: {
          blId: bl.id,
          numero: bl.numero,
          nonSigne: bl.statut === 'NON_SIGNE_DEPOSE',
          le: bl.signe_le,
          lieuDepot: bl.lieu_depot,
          signataire: bl.signataire_nom,
          photos: photos.map((p) => ({ id: p.id, ...this.files.photoUrls(user.tenantId, p.id) })),
          articles: arts,
          signalementJusquau: until,
          signalementPossible: !!until && until.getTime() > Date.now(),
        },
        litiges,
      };
    });
  }

  @Get()
  @RequirePermission('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query('commandeId') commandeId?: string) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<DisputeRow>(
        `SELECT * FROM litige WHERE ($1::uuid IS NULL OR commande_id = $1) ORDER BY created_at DESC LIMIT 50`,
        [commandeId ? uuid.parse(commandeId) : null],
      );
      const items = [];
      for (const d of r.rows) items.push(await presentDispute(tx, this.files, user.tenantId, d));
      return { items };
    });
  }
}

/** Back-Office : file des litiges et réponse au client. */
@Controller('bo/disputes')
export class BoDisputesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('mission.assign')
  list(@CurrentUser() user: AuthUser, @Query('statut') statut?: string) {
    const s = statut ? z.enum(['OUVERT', 'EN_COURS', 'RESOLU', 'REJETE', 'A_TRAITER']).parse(statut) : null;
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT l.id, l.numero, l.motif, l.statut, l.created_at AS "creeLe", l.traite_le AS "traiteLe", e.nom AS client, c.numero AS commande,
                b.numero AS bl, jsonb_array_length(l.photos)::int AS "nbPhotos", left(l.description, 140) AS extrait
           FROM litige l JOIN entreprise e ON e.id = l.entreprise_id JOIN commande c ON c.id = l.commande_id JOIN bon_de_livraison b ON b.id = l.bl_id
          WHERE ($1::text IS NULL OR ($1 = 'A_TRAITER' AND l.statut IN ('OUVERT','EN_COURS')) OR l.statut = $1)
          ORDER BY (l.statut IN ('OUVERT','EN_COURS')) DESC, l.created_at DESC LIMIT 200`,
        [s],
      );
      const counts = await tx.query<{ statut: string; n: number }>('SELECT statut, count(*)::int AS n FROM litige GROUP BY statut');
      return { items: r.rows, compteurs: Object.fromEntries(counts.rows.map((x) => [x.statut, x.n])) };
    });
  }

  @Get(':id')
  @RequirePermission('mission.assign')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const d = (await tx.query<DisputeRow>('SELECT * FROM litige WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!d) throw notFound('Litige');
      const bl = (
        await tx.query<{ id: string; numero: string; statut: string; signe_le: Date; signataire_nom: string | null; lieu_depot: string | null; reserves: number }>(
          `SELECT b.id, b.numero, b.statut, b.signe_le, b.signataire_nom, b.lieu_depot, (SELECT count(*)::int FROM reserve r WHERE r.bl_id = b.id) AS reserves
             FROM bon_de_livraison b WHERE b.id = $1`,
          [d.bl_id],
        )
      ).rows[0];
      return { ...(await presentDispute(tx, this.files, user.tenantId, d)), livraison: bl };
    });
  }

  /** Prise en charge, résolution ou rejet, avec une réponse au client ; un geste commercial est déduit de la prochaine facture. */
  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission('mission.assign')
  resolve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = ResolveBody.parse(body);
    if (b.gesteCents && b.statut !== 'RESOLU') throw unprocessable('GESTE', 'Un geste commercial accompagne une résolution');
    if (b.gesteCents && user.role !== 'SUPER_ADMIN') throw forbidden('Un geste commercial est décidé par un Super Admin');
    return this.db.tx(ctxOf(user), async (tx) => {
      const d = (await tx.query<DisputeRow>('SELECT * FROM litige WHERE id = $1 FOR UPDATE', [uuid.parse(id)])).rows[0];
      if (!d) throw notFound('Litige');
      if (d.statut === 'RESOLU' || d.statut === 'REJETE') throw conflict('LITIGE_CLOS', 'Ce litige est déjà clos');
      await tx.query(`UPDATE litige SET statut = $2, reponse = $3, geste_cents = $4, traite_par = $5, traite_le = now() WHERE id = $1`, [
        d.id, b.statut, b.reponse, b.gesteCents ?? null, user.id,
      ]);
      if (b.gesteCents) {
        await tx.query(
          `INSERT INTO prestation_a_facturer (id, tenant_id, entreprise_id, code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, source_id, date_prestation)
           VALUES ($1,$2,$3,'GESTE_COMMERCIAL',$4,1,'forfait',$5,20,$6,current_date)`,
          [uuidv7(), user.tenantId, d.entreprise_id, `Geste commercial, litige ${d.numero}`, -b.gesteCents, d.id],
        );
      }
      await this.audit.record(tx, user, {
        action: 'LITIGE_TRAITE',
        objet: 'litige',
        objetId: d.id,
        entrepriseId: d.entreprise_id,
        avant: { statut: d.statut },
        apres: { statut: b.statut, gesteCents: b.gesteCents ?? null },
        motif: b.reponse,
      });
      const numeroCommande = (await tx.query<{ numero: string | null }>('SELECT numero FROM commande WHERE id = $1', [d.commande_id])).rows[0]?.numero;
      const vars = { litige: d.numero, statut: b.statut, reponse: b.reponse, gesteCents: b.gesteCents ?? null, commandeId: d.commande_id, numero: numeroCommande };
      await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,$3,'IN_APP','LITIGE_TRAITE',$4)`, [
        uuidv7(), user.tenantId, d.cree_par, JSON.stringify(vars),
      ]);
      await NotificationsService.enqueue(tx, user.tenantId, { modele: 'LITIGE_TRAITE', destinataireId: d.cree_par, variables: vars });
      return { id: d.id, statut: b.statut };
    });
  }
}

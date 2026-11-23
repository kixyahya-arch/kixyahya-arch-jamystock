import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { groupByPiece, isClientRole, normalizePiece, parisClock, uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from '../files/files.service.js';
import { PIECE_A_REPARTIR, PLANCHE_AMBIANCE, planchePdf } from '../billing/pdf.js';
import { OrdersService } from './orders.service.js';

/**
 * Packs (CMD-08 étendu, compte rendu Adam du 21/11) : un ensemble nommé de biens, rattaché ou non à un site, que
 * le client remet au panier en un clic. Chaque bien peut être placé dans une pièce ; la planche d'aménagement
 * (PDF) montre les meubles pièce par pièce, en photos. Le client compose ses packs, le Back-Office aussi pour lui.
 * Stockés dans modele_panier (les « modèles de panier » existants deviennent des packs).
 */

const uuid = z.string().uuid();
const clientOnly = (user: AuthUser) => {
  if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
};

const Pieces = z.record(z.string().uuid(), z.string().max(80).nullable());
const Description = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

const PackBody = z.object({
  nom: z.string().trim().min(1, 'Donnez un nom au pack').max(80),
  description: Description,
  projetId: uuid.optional(),
  /** à défaut, le contenu du panier en cours ; une liste vide crée un pack à remplir ensuite */
  articleIds: z.array(uuid).max(500).optional(),
  pieces: Pieces.optional(),
});
const PackPatch = z.object({
  nom: z.string().trim().min(1, 'Donnez un nom au pack').max(80).optional(),
  description: Description,
  articleIds: z.array(uuid).max(500).optional(),
  pieces: Pieces.optional(),
});
/** Back-Office : biens désignés par leur étiquette (scannée ou collée), avec leur pièce. */
const BoPackBody = z.object({
  nom: z.string().trim().min(1, 'Donnez un nom au pack').max(80),
  description: Description,
  projetId: uuid.optional(),
  biens: z
    .array(z.object({ qr: z.string().trim().min(1).max(80), piece: z.string().max(80).nullable().optional() }))
    .min(1, 'Indiquez au moins une étiquette')
    .max(500),
});

/** Raison pour laquelle un bien d'un pack ne peut pas être commandé maintenant. */
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
const STATUT: Record<string, string> = {
  ATTENDU: 'Attendu au dépôt',
  EN_RECEPTION: 'En réception',
  EN_STOCK: 'Au dépôt',
  RESERVE: 'Réservé',
  EN_PREPARATION: 'En préparation',
  EN_TRANSIT: 'En livraison',
  RESTITUE: 'Livré',
  PERDU: 'Perdu',
  DETRUIT: 'Détruit',
};

export interface PackRow {
  id: string;
  nom: string;
  description: string | null;
  entreprise_id: string;
  entreprise: string | null;
  projet_id: string | null;
  projet: string | null;
  article_ids: string[];
  pieces: Record<string, string>;
  cree_par: string;
  auteur: string | null;
  created_at: Date;
  utilise_le: Date | null;
  modifie_le: Date | null;
}

interface AmbianceRow {
  id: string;
  piece: string;
  source: 'IA' | 'MANUEL';
  statut: 'EN_COURS' | 'PRET' | 'ECHEC' | 'SUPPRIME';
  cle: string | null;
  erreur: string | null;
  created_at: Date;
}

export interface AmbianceView {
  id: string;
  statut: 'EN_COURS' | 'PRET' | 'ECHEC';
  source: 'IA' | 'MANUEL';
  url: string | null;
  erreur: string | null;
  le: Date;
}

export interface PackArticle {
  id: string;
  libelle: string;
  qr: string;
  statut: string;
  engage: boolean;
  projet_id: string | null;
  projet: string | null;
  longueur_m: number | null;
  largeur_m: number | null;
  hauteur_m: number | null;
  photo: string | null;
}

export const dims = (a: Pick<PackArticle, 'longueur_m' | 'largeur_m' | 'hauteur_m'>) =>
  a.longueur_m && a.largeur_m ? `${[a.longueur_m, a.largeur_m, a.hauteur_m].filter((v) => v != null).map((v) => Number(v).toLocaleString('fr-FR')).join(' × ')} m` : null;

export function unavailable(a: Pick<PackArticle, 'statut' | 'engage'> | undefined): string | null {
  if (!a) return 'n’est plus accessible';
  if (a.statut === 'EN_STOCK' && !a.engage) return null;
  if (a.statut === 'EN_STOCK') return 'déjà dans une autre commande';
  return UNAVAILABLE[a.statut] ?? 'indisponible';
}

/** Pièces gardées pour les seuls biens du pack, nettoyées. */
function cleanPieces(ids: string[], pieces: Record<string, string | null> | undefined, previous: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const p = pieces && id in pieces ? normalizePiece(pieces[id]) : (previous[id] ?? null);
    if (p) out[id] = p;
  }
  return out;
}

@Injectable()
export class PacksService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Dernier visuel de chaque pièce du pack ; une génération restée en cours après le délai est montrée en échec. */
  async ambiances(tx: Tx, user: AuthUser, packId: string): Promise<Map<string, AmbianceView>> {
    const r = await tx.query<AmbianceRow>(
      `SELECT DISTINCT ON (piece) id, piece, source, statut, cle, erreur, created_at FROM pack_ambiance WHERE pack_id = $1 ORDER BY piece, created_at DESC, id DESC`,
      [packId],
    );
    const stale = Date.now() - this.config.higgsfield.timeoutMs - 3 * 60_000;
    const out = new Map<string, AmbianceView>();
    for (const a of r.rows) {
      if (a.statut === 'SUPPRIME') continue;
      const interrompue = a.statut === 'EN_COURS' && a.created_at.getTime() < stale;
      out.set(a.piece, {
        id: a.id,
        statut: interrompue ? 'ECHEC' : a.statut,
        source: a.source,
        url: a.statut === 'PRET' && a.cle ? this.files.ambianceUrl(user.tenantId, a.id) : null,
        erreur: interrompue ? 'Génération interrompue, relancez-la' : a.erreur,
        le: a.created_at,
      });
    }
    return out;
  }

  /**
   * Générations IA restantes ce mois-ci. Une génération échouée (erreur renseignée) n'est pas facturée par
   * Higgsfield et ne compte pas ; un visuel retiré ensuite reste compté. Mois de Paris, plafond par client et
   * plafond global de l'organisation.
   */
  async quota(tenantId: string, entrepriseId: string): Promise<number> {
    const h = this.config.higgsfield;
    const r = await this.db.tx({ tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query<{ client: number; total: number }>(
        `SELECT count(*) FILTER (WHERE entreprise_id = $1)::int AS client, count(*)::int AS total FROM pack_ambiance
          WHERE source = 'IA' AND erreur IS NULL AND created_at >= (date_trunc('month', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris')`,
        [entrepriseId],
      ),
    );
    const { client, total } = r.rows[0]!;
    return Math.max(0, Math.min(h.maxParClientParMois - client, h.maxParMois - total));
  }

  async removeFiles(keys: string[]) {
    for (const k of keys) await this.storage.remove(k).catch(() => undefined);
  }

  get iaActive(): boolean {
    return !!(this.config.higgsfield.keyId && this.config.higgsfield.keySecret);
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<PackRow> {
    const m = (
      await tx.query<PackRow>(
        `SELECT m.id, m.nom, m.description, m.entreprise_id, e.nom AS entreprise, m.projet_id, p.nom AS projet, m.article_ids, m.pieces,
                m.cree_par, u.nom AS auteur, m.created_at, m.utilise_le, m.modifie_le
           FROM modele_panier m JOIN entreprise e ON e.id = m.entreprise_id LEFT JOIN projet p ON p.id = m.projet_id LEFT JOIN utilisateur u ON u.id = m.cree_par
          WHERE m.id = $1 ${forUpdate ? 'FOR UPDATE OF m' : ''}`,
        [uuid.parse(id)],
      )
    ).rows[0];
    if (!m) throw notFound('Pack');
    return m;
  }

  /** Biens d'un pack, vus avec les droits de l'utilisateur : un bien qu'il ne voit plus est indisponible. */
  async articles(tx: Tx, ids: string[]): Promise<Map<string, PackArticle>> {
    if (!ids.length) return new Map();
    const r = await tx.query<PackArticle>(
      `SELECT a.id, coalesce(a.nom_client, a.libelle) AS libelle, a.qr_code AS qr, a.statut, a.projet_id, p.nom AS projet,
              a.longueur_m::float AS longueur_m, a.largeur_m::float AS largeur_m, a.hauteur_m::float AS hauteur_m,
              EXISTS (SELECT 1 FROM ligne_commande l WHERE l.article_id = a.id AND l.active) AS engage,
              (SELECT ph.id FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le, ph.id LIMIT 1) AS photo
         FROM article a LEFT JOIN projet p ON p.id = a.projet_id WHERE a.id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(r.rows.map((a) => [a.id, a]));
  }

  /** Vérifie qu'une liste de biens peut former un pack : visibles, de l'entreprise, du site du pack s'il en a un. */
  async checkArticles(tx: Tx, entrepriseId: string, projetId: string | null, ids: string[]) {
    const uniq = [...new Set(ids)];
    const r = await tx.query<{ id: string; entreprise_id: string; projet_id: string | null; libelle: string }>(
      'SELECT id, entreprise_id, projet_id, libelle FROM article WHERE id = ANY($1::uuid[])',
      [uniq],
    );
    if (r.rows.length !== uniq.length || r.rows.some((a) => a.entreprise_id !== entrepriseId)) throw notFound('Article');
    const ailleurs = projetId ? r.rows.filter((a) => a.projet_id !== projetId) : [];
    if (ailleurs.length) throw unprocessable('PROJET_DIFFERENT', `« ${ailleurs[0]!.libelle} » n’appartient pas au site de ce pack`);
    return uniq;
  }

  /** Résumé d'un pack pour une liste. */
  async summary(tx: Tx, user: AuthUser, rows: PackRow[]) {
    const all = await this.articles(tx, [...new Set(rows.flatMap((m) => m.article_ids))]);
    return rows.map((m) => {
      const covers = m.article_ids
        .map((id) => all.get(id)?.photo)
        .filter((x): x is string => !!x)
        .slice(0, 4);
      return {
        id: m.id,
        nom: m.nom,
        description: m.description,
        projetId: m.projet_id,
        projet: m.projet,
        auteur: m.auteur,
        creeLe: m.created_at,
        utiliseLe: m.utilise_le,
        nbArticles: m.article_ids.length,
        nbDisponibles: m.article_ids.filter((id) => !unavailable(all.get(id))).length,
        pieces: [...new Set(Object.values(m.pieces ?? {}))].length,
        vignettes: covers.map((p) => this.files.photoUrl(user.tenantId, p, 't')),
        supprimable: !isClientRole(user.role) || m.cree_par === user.id || user.role !== 'B2B_USER',
      };
    });
  }

  /** Détail : biens regroupés par pièce, avec leur photo et leur disponibilité du moment. */
  async detail(tx: Tx, user: AuthUser, m: PackRow) {
    const all = await this.articles(tx, m.article_ids);
    const amb = await this.ambiances(tx, user, m.id);
    const items = m.article_ids.map((aid) => {
      const a = all.get(aid);
      return {
        id: aid,
        libelle: a?.libelle ?? 'Bien retiré de votre périmètre',
        qr: a?.qr ?? null,
        statut: a ? (STATUT[a.statut] ?? a.statut) : null,
        projet: a?.projet ?? null,
        dimensions: a ? dims(a) : null,
        /** en mètres, pour la vue 3D de la pièce */
        mesures: a?.longueur_m && a.largeur_m ? { longueur: Number(a.longueur_m), largeur: Number(a.largeur_m), hauteur: a.hauteur_m ? Number(a.hauteur_m) : null } : null,
        piece: m.pieces?.[aid] ?? null,
        indisponible: unavailable(a),
        vignette: a?.photo ? this.files.photoUrl(user.tenantId, a.photo, 't') : null,
        photo: a?.photo ? this.files.photoUrl(user.tenantId, a.photo, 'm') : null,
      };
    });
    return {
      id: m.id,
      nom: m.nom,
      description: m.description,
      client: m.entreprise,
      projetId: m.projet_id,
      projet: m.projet,
      auteur: m.auteur,
      creeLe: m.created_at,
      modifieLe: m.modifie_le,
      modifiable: !isClientRole(user.role) || m.cree_par === user.id || user.role !== 'B2B_USER',
      nbArticles: items.length,
      nbDisponibles: items.filter((a) => !a.indisponible).length,
      pieces: groupByPiece(items, (a) => a.piece).map((g) => ({ piece: g.piece, articles: g.items, ambiance: g.piece ? (amb.get(g.piece) ?? null) : null })),
      articles: items,
      visuels: { ia: this.iaActive, restantsCeMois: this.iaActive ? await this.quota(user.tenantId, m.entreprise_id) : null },
    };
  }

  /** Planche d'aménagement en PDF : les photos sont relues en JPEG, une à la fois (petit serveur). */
  async planche(user: AuthUser, id: string): Promise<{ name: string; data: Buffer }> {
    const job = await this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.load(tx, id);
      const all = await this.articles(tx, m.article_ids);
      const keys = await tx.query<{ id: string; cle: string }>(
        'SELECT id, coalesce(cle_moyenne, cle_originale) AS cle FROM photo WHERE id = ANY($1::uuid[])',
        [[...all.values()].map((a) => a.photo).filter(Boolean)],
      );
      const emetteur = (await tx.query<{ raison_sociale: string }>('SELECT raison_sociale FROM organisation WHERE id = app_tenant()')).rows[0]?.raison_sociale ?? 'JAMYSTOCK';
      const amb = await tx.query<{ piece: string; cle: string }>(
        `SELECT DISTINCT ON (piece) piece, cle FROM pack_ambiance WHERE pack_id = $1 AND statut = 'PRET' AND cle IS NOT NULL ORDER BY piece, created_at DESC, id DESC`,
        [m.id],
      );
      return { m, all, keys: new Map(keys.rows.map((k) => [k.id, k.cle])), emetteur, ambiances: new Map(amb.rows.map((a) => [a.piece, a.cle])) };
    });
    const visibles = job.m.article_ids.map((aid) => job.all.get(aid)).filter((a): a is PackArticle => !!a);
    const groups = groupByPiece(visibles, (a) => job.m.pieces?.[a.id] ?? null);
    const pieces = [];
    for (const g of groups) {
      const biens = [];
      for (const a of g.items) {
        const key = a.photo ? job.keys.get(a.photo) : undefined;
        const photo = key
          ? await this.storage
              .get(key)
              // meuble entier, sur fond blanc (planche de décoration)
              .then((b) => sharp(b, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).resize(640, 640, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer())
              .catch(() => null)
          : null;
        biens.push({ libelle: a.libelle, qr: a.qr, dimensions: dims(a), statut: `${STATUT[a.statut] ?? a.statut}${a.projet ? ` · ${a.projet}` : ''}`, photo });
      }
      const ambKey = g.piece ? job.ambiances.get(g.piece) : undefined;
      const ambiance = ambKey
        ? await this.storage
            .get(ambKey)
            .then((b) => sharp(b, { failOn: 'none' }).resize(PLANCHE_AMBIANCE.width, PLANCHE_AMBIANCE.height, { fit: 'cover' }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer())
            .catch(() => null)
        : null;
      pieces.push({ nom: g.piece ?? PIECE_A_REPARTIR, ambiance, biens });
    }
    const at = new Date();
    const data = await planchePdf({ emetteur: job.emetteur, client: job.m.entreprise ?? 'Client', pack: job.m.nom, site: job.m.projet, description: job.m.description, genereLe: at, pieces });
    const slug = job.m.nom
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 50);
    return { name: `planche-${slug || 'pack'}-${parisClock(at).date}.pdf`, data };
  }
}

function sendPdf(res: Response, f: { name: string; data: Buffer }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(f.data);
}

/** Espace Client : les packs du client (route historique des modèles de panier). */
@Controller('me/cart-templates')
export class CartTemplatesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PacksService) private readonly packs: PacksService,
  ) {}

  @Get()
  @RequirePermission('order.create')
  list(@CurrentUser() user: AuthUser) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const ids = await tx.query<{ id: string }>('SELECT id FROM modele_panier ORDER BY coalesce(utilise_le, modifie_le, created_at) DESC');
      const rows = [];
      for (const r of ids.rows) rows.push(await this.packs.load(tx, r.id));
      return { items: await this.packs.summary(tx, user, rows) };
    });
  }

  @Post()
  @RequirePermission('order.create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    clientOnly(user);
    const b = PackBody.parse(body);
    if (user.role === 'B2B_USER' && !b.projetId) throw unprocessable('PROJET_REQUIS', 'Un pack d’utilisateur B2B se rattache à un projet');
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
      if (!ids.length && !b.articleIds) throw unprocessable('PANIER_VIDE', 'Le panier est vide : ajoutez des biens avant de l’enregistrer comme pack');
      if (b.projetId && !(await tx.query('SELECT 1 FROM projet WHERE id = $1', [b.projetId])).rowCount) throw notFound('Projet');
      const uniq = await this.packs.checkArticles(tx, user.entrepriseId!, b.projetId ?? null, ids);
      const dup = await tx.query('SELECT 1 FROM modele_panier WHERE lower(nom) = lower($1) AND projet_id IS NOT DISTINCT FROM $2::uuid', [b.nom, b.projetId ?? null]);
      if (dup.rowCount) throw conflict('NOM_PRIS', 'Un pack porte déjà ce nom');
      const id = uuidv7();
      await tx.query(
        `INSERT INTO modele_panier (id, tenant_id, entreprise_id, projet_id, nom, description, article_ids, pieces, cree_par) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, user.tenantId, user.entrepriseId, b.projetId ?? null, b.nom, b.description ?? null, uniq, JSON.stringify(cleanPieces(uniq, b.pieces)), user.id],
      );
      return { id, nom: b.nom, nbArticles: uniq.length };
    });
  }

  @Get(':id')
  @RequirePermission('order.create')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => this.packs.detail(tx, user, await this.packs.load(tx, id)));
  }

  /** Renommer, décrire, ajouter ou retirer des biens, placer chaque bien dans une pièce. */
  @Put(':id')
  @RequirePermission('order.create')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    clientOnly(user);
    const b = PackPatch.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, id, true);
      if (user.role === 'B2B_USER' && m.cree_par !== user.id) throw forbidden('Seul son auteur ou un administrateur modifie un pack');
      return updatePack(tx, this.packs, user, m, b);
    });
  }

  @Get(':id/planche.pdf')
  @RequirePermission('order.create')
  async planche(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    clientOnly(user);
    sendPdf(res, await this.packs.planche(user, id));
  }

  /** Commander le pack : les biens disponibles vont au panier, les autres sont signalés. */
  @Post(':id/use')
  @HttpCode(200)
  @RequirePermission('order.create')
  async use(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    clientOnly(user);
    const { m, ready, missing } = await this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, id);
      const all = await this.packs.articles(tx, m.article_ids);
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
        const reason = unavailable(all.get(aid));
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
      const m = await this.packs.load(tx, id, true);
      if (user.role === 'B2B_USER' && m.cree_par !== user.id) throw forbidden('Seul son auteur ou un administrateur supprime un pack');
      const keys = await releaseAmbiances(tx, m.id);
      await tx.query('DELETE FROM modele_panier WHERE id = $1', [m.id]);
      return { supprime: true, keys };
    }).then(async ({ supprime, keys }) => {
      await this.packs.removeFiles(keys);
      return { supprime };
    });
  }
}

/** Avant la suppression d'un pack : ses visuels passent en SUPPRIME (ils restent comptés) ; renvoie les fichiers à effacer. */
async function releaseAmbiances(tx: Tx, packId: string): Promise<string[]> {
  const r = await tx.query<{ cle: string | null }>(`UPDATE pack_ambiance SET statut = 'SUPPRIME', termine_le = coalesce(termine_le, now()) WHERE pack_id = $1 AND statut <> 'SUPPRIME' RETURNING cle`, [packId]);
  return r.rows.map((x) => x.cle).filter((x): x is string => !!x);
}

async function updatePack(tx: Tx, packs: PacksService, user: AuthUser, m: PackRow, b: z.infer<typeof PackPatch>) {
  const nom = b.nom ?? m.nom;
  if (b.nom && b.nom.toLowerCase() !== m.nom.toLowerCase()) {
    const dup = await tx.query('SELECT 1 FROM modele_panier WHERE lower(nom) = lower($1) AND projet_id IS NOT DISTINCT FROM $2::uuid AND id <> $3', [b.nom, m.projet_id, m.id]);
    if (dup.rowCount) throw conflict('NOM_PRIS', 'Un pack porte déjà ce nom');
  }
  // un bien déjà dans le pack y reste même s'il est sorti du site depuis ; seuls les ajouts sont contrôlés
  let ids = m.article_ids;
  if (b.articleIds) {
    const uniq = [...new Set(b.articleIds)];
    const added = uniq.filter((x) => !m.article_ids.includes(x));
    if (added.length) await packs.checkArticles(tx, m.entreprise_id, m.projet_id, added);
    ids = uniq;
  }
  const pieces = cleanPieces(ids, b.pieces, m.pieces);
  await tx.query(`UPDATE modele_panier SET nom = $2, description = $3, article_ids = $4, pieces = $5, modifie_le = now() WHERE id = $1`, [
    m.id,
    nom,
    b.description === undefined ? m.description : b.description,
    ids,
    JSON.stringify(pieces),
  ]);
  return packs.detail(tx, user, await packs.load(tx, m.id));
}

/** Back-Office : packs composés pour un client (par exemple les meubles d'un appartement témoin). */
@Controller('bo')
export class BoPacksController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PacksService) private readonly packs: PacksService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('clients/:id/packs')
  @RequirePermission('client.manage')
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const ids = await tx.query<{ id: string }>('SELECT id FROM modele_panier WHERE entreprise_id = $1 ORDER BY coalesce(modifie_le, created_at) DESC', [uuid.parse(id)]);
      const rows = [];
      for (const r of ids.rows) rows.push(await this.packs.load(tx, r.id));
      return { items: await this.packs.summary(tx, user, rows) };
    });
  }

  @Post('clients/:id/packs')
  @RequirePermission('client.manage')
  create(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const entrepriseId = uuid.parse(id);
    const b = BoPackBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      if (!(await tx.query('SELECT 1 FROM entreprise WHERE id = $1', [entrepriseId])).rowCount) throw notFound('Client');
      if (b.projetId && !(await tx.query('SELECT 1 FROM projet WHERE id = $1 AND entreprise_id = $2', [b.projetId, entrepriseId])).rowCount) throw notFound('Projet');
      const qrs = [...new Set(b.biens.map((x) => x.qr.toUpperCase()))];
      const found = await tx.query<{ id: string; qr: string }>('SELECT id, upper(qr_code) AS qr FROM article WHERE entreprise_id = $1 AND upper(qr_code) = ANY($2::text[])', [entrepriseId, qrs]);
      const byQr = new Map(found.rows.map((a) => [a.qr, a.id]));
      const inconnues = qrs.filter((q) => !byQr.has(q));
      if (inconnues.length) throw unprocessable('ETIQUETTE_INCONNUE', `Étiquette${inconnues.length > 1 ? 's' : ''} introuvable${inconnues.length > 1 ? 's' : ''} chez ce client : ${inconnues.slice(0, 5).join(', ')}`);
      const ids = await this.packs.checkArticles(tx, entrepriseId, b.projetId ?? null, qrs.map((q) => byQr.get(q)!));
      const pieces: Record<string, string | null> = {};
      for (const x of b.biens) pieces[byQr.get(x.qr.toUpperCase())!] = x.piece ?? null;
      const dup = await tx.query('SELECT 1 FROM modele_panier WHERE entreprise_id = $3 AND lower(nom) = lower($1) AND projet_id IS NOT DISTINCT FROM $2::uuid', [b.nom, b.projetId ?? null, entrepriseId]);
      if (dup.rowCount) throw conflict('NOM_PRIS', 'Ce client a déjà un pack de ce nom');
      const packId = uuidv7();
      await tx.query(
        `INSERT INTO modele_panier (id, tenant_id, entreprise_id, projet_id, nom, description, article_ids, pieces, cree_par) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [packId, user.tenantId, entrepriseId, b.projetId ?? null, b.nom, b.description ?? null, ids, JSON.stringify(cleanPieces(ids, pieces)), user.id],
      );
      await this.audit.record(tx, user, { action: 'PACK_CREE', objet: 'modele_panier', objetId: packId, entrepriseId, apres: { nom: b.nom, nbArticles: ids.length } });
      return { id: packId, nom: b.nom, nbArticles: ids.length };
    });
  }

  @Get('packs/:id')
  @RequirePermission('client.manage')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => this.packs.detail(tx, user, await this.packs.load(tx, id)));
  }

  @Put('packs/:id')
  @RequirePermission('client.manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = PackPatch.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => updatePack(tx, this.packs, user, await this.packs.load(tx, id, true), b));
  }

  @Get('packs/:id/planche.pdf')
  @RequirePermission('client.manage')
  async planche(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    sendPdf(res, await this.packs.planche(user, id));
  }

  @Delete('packs/:id')
  @RequirePermission('client.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = await this.packs.load(tx, id, true);
      const keys = await releaseAmbiances(tx, m.id);
      await tx.query('DELETE FROM modele_panier WHERE id = $1', [m.id]);
      await this.audit.record(tx, user, { action: 'PACK_SUPPRIME', objet: 'modele_panier', objetId: m.id, entrepriseId: m.entreprise_id, apres: { nom: m.nom } });
      return { supprime: true, keys };
    }).then(async ({ supprime, keys }) => {
      await this.packs.removeFiles(keys);
      return { supprime };
    });
  }
}

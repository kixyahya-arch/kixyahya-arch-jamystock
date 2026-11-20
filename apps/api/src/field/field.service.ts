import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_CLOCK_SKEW_MS,
  MAX_PHOTOS_PER_ARTICLE,
  applyMovement,
  assertCanStore,
  blContent,
  blFingerprint,
  can,
  formatDocumentNumber,
  generateQrCode,
  haversineMeters,
  isActiveArticle,
  parseQr,
  pickupContent,
  pickupFingerprint,
  sortByPath,
  uuidv7,
  type ArticleStatus,
  type FieldAction,
  type MovementType,
  type OrderStatus,
  type Permission,
  type SyncEnvelope,
  type SyncRequest,
  type SyncResult,
} from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { BusinessError, conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { OrdersService, type OrderRow } from '../orders/orders.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FilesService } from '../files/files.service.js';
import { usageColumns } from '../warehouse/occupancy.js';

/** Contexte d'exécution d'une action terrain. */
interface ActionCtx {
  user: AuthUser;
  deviceId: string;
  /** horodatage terminal, corrigé de la dérive d'horloge si elle dépasse 2 min */
  at: Date;
  warnings: string[];
}

interface ArticleRow {
  id: string;
  tenant_id: string;
  entreprise_id: string;
  projet_id: string | null;
  qr_code: string;
  libelle: string;
  statut: ArticleStatus;
  emplacement_courant_id: string | null;
  um_courante_id: string | null;
  longueur_m: number | null;
  largeur_m: number | null;
  poids_kg: number | null;
  empilable: boolean;
  commande_collecte_id: string | null;
  dernier_mouvement_terminal: Date | null;
}

interface LocationRow {
  id: string;
  code: string;
  chemin: string;
  statut: string;
  type: string;
  surface_m2: number;
  charge_max_kg: number | null;
  zone_type: string;
  adressable: boolean;
}

interface UmRow {
  id: string;
  qr_code: string;
  entreprise_id: string | null;
  emplacement_courant_id: string | null;
  longueur_m: number;
  largeur_m: number;
  empilable: boolean;
  dernier_mouvement_terminal: Date | null;
}

interface MissionRow {
  id: string;
  commande_id: string | null;
  type: string;
  statut: string;
  assigne_a: string | null;
  donnees: Record<string, unknown>;
}

/** Permission requise par type d'action (§2.2). */
const ACTION_PERMISSION: Record<FieldAction['type'], Permission> = {
  ARTICLE_CREATE: 'stock.move',
  ARTICLE_STORE: 'stock.move',
  TRANSFER: 'stock.move',
  UM_CREATE: 'stock.move',
  UM_ADD: 'stock.move',
  UM_STORE: 'stock.move',
  RECEPTION_CLOSE: 'stock.move',
  RETURN: 'stock.move',
  PICK: 'picking.execute',
  PICK_MISSING: 'picking.execute',
  PICK_COMPLETE: 'picking.execute',
  UM_SPLIT: 'picking.execute',
  LOAD: 'picking.execute',
  DEPART: 'delivery.execute',
  ARRIVE: 'delivery.execute',
  BL_SIGN: 'delivery.execute',
  PICKUP_SIGN: 'delivery.execute',
  PHOTO_REQUEST_DONE: 'stock.move',
  LOCATION_COUNT: 'stock.move',
};

/** Distance au-delà de laquelle « Arrivé » déclenche une alerte de cohérence (§4.3). */
const ARRIVAL_MAX_DISTANCE_M = 500;

@Injectable()
export class FieldService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  // =====================================================================================
  // Synchronisation (§7.5)
  // =====================================================================================

  /**
   * Rejoue les actions dans l'ordre de l'horodatage terminal. Chaque action a sa propre transaction :
   * une erreur métier n'empêche pas les suivantes. Les réponses (succès ou erreur métier) sont mémorisées
   * par clé d'idempotence ; un renvoi de la même clé rend la réponse mémorisée.
   */
  async sync(user: AuthUser, req: SyncRequest, serverNow = new Date()): Promise<{ results: SyncResult[]; clockSkewMs: number; serverTime: string }> {
    const skew = serverNow.getTime() - Date.parse(req.deviceTime);
    const correct = Math.abs(skew) > MAX_CLOCK_SKEW_MS;
    if (correct) {
      await this.db.tx(ctxOf(user), (tx) =>
        this.alert(tx, user, 'HORLOGE', { details: { deviceId: req.deviceId, ecartMs: skew } }),
      );
    }
    const ordered = [...req.actions].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const results: SyncResult[] = [];
    for (const env of ordered) {
      results.push(await this.runOne(user, req.deviceId, env, correct ? skew : 0));
    }
    // on rend les résultats dans l'ordre d'envoi pour que le terminal purge sa file facilement
    const byKey = new Map(results.map((r) => [r.key, r]));
    return { results: req.actions.map((a) => byKey.get(a.key)!), clockSkewMs: skew, serverTime: serverNow.toISOString() };
  }

  private async runOne(user: AuthUser, deviceId: string, env: SyncEnvelope, skew: number): Promise<SyncResult> {
    const previous = await this.db.tx(ctxOf(user), (tx) =>
      tx.query<{ reponse: SyncResult }>('SELECT reponse FROM action_synchronisee WHERE tenant_id = $1 AND cle_idempotence = $2', [
        user.tenantId,
        env.key,
      ]),
    );
    if (previous.rows[0]) return { ...previous.rows[0].reponse, replayed: true };

    const permission = ACTION_PERMISSION[env.action.type];
    let result: SyncResult;
    try {
      if (!permission) throw unprocessable('ACTION_INCONNUE', `Action inconnue : ${(env.action as { type: string }).type}`);
      if (!can(user.role, permission)) throw forbidden(`Permission ${permission} requise`);
      const ctx: ActionCtx = { user, deviceId, at: new Date(Date.parse(env.at) + skew), warnings: [] };
      result = await this.db.tx(ctxOf(user), async (tx) => {
        const data = await this.dispatch(tx, ctx, env.action);
        const ok: SyncResult = { key: env.key, status: 'OK', data, ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}) };
        await this.remember(tx, user, deviceId, env, ok, skew);
        return ok;
      });
    } catch (err) {
      const business = toBusiness(err);
      if (!business) throw err; // erreur technique : non mémorisée, le terminal réessaiera
      result = { key: env.key, status: 'ERROR', code: business.code, message: business.message };
      await this.db.tx(ctxOf(user), (tx) => this.remember(tx, user, deviceId, env, result, skew));
    }
    return result;
  }

  private async remember(tx: Tx, user: AuthUser, deviceId: string, env: SyncEnvelope, res: SyncResult, skew: number) {
    await tx.query(
      `INSERT INTO action_synchronisee (cle_idempotence, tenant_id, utilisateur_id, appareil_id, type_action, reponse, ecart_horloge_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [env.key, user.tenantId, user.id, deviceId, env.action.type, JSON.stringify(res), skew || null],
    );
  }

  private dispatch(tx: Tx, ctx: ActionCtx, action: FieldAction): Promise<unknown> {
    switch (action.type) {
      case 'ARTICLE_CREATE':
        return this.articleCreate(tx, ctx, action.payload);
      case 'ARTICLE_STORE':
        return this.articleStore(tx, ctx, action.payload);
      case 'TRANSFER':
        return this.transfer(tx, ctx, action.payload);
      case 'UM_CREATE':
        return this.umCreate(tx, ctx, action.payload);
      case 'UM_ADD':
        return this.umAdd(tx, ctx, action.payload);
      case 'UM_STORE':
        return this.umStore(tx, ctx, action.payload);
      case 'RECEPTION_CLOSE':
        return this.receptionClose(tx, ctx, action.payload.commandeId);
      case 'RETURN':
        return this.returnToDepot(tx, ctx, action.payload);
      case 'PHOTO_REQUEST_DONE':
        return this.photoRequestDone(tx, ctx, action.payload);
      case 'PICK':
        return this.pick(tx, ctx, action.payload);
      case 'PICK_MISSING':
        return this.pickMissing(tx, ctx, action.payload);
      case 'PICK_COMPLETE':
        return this.pickComplete(tx, ctx, action.payload.missionId);
      case 'UM_SPLIT':
        return this.umSplit(tx, ctx, action.payload);
      case 'LOAD':
        return this.load(tx, ctx, action.payload);
      case 'DEPART':
        return this.depart(tx, ctx, action.payload.missionId);
      case 'ARRIVE':
        return this.arrive(tx, ctx, action.payload);
      case 'BL_SIGN':
        return this.blSign(tx, ctx, action.payload);
      case 'PICKUP_SIGN':
        return this.pickupSign(tx, ctx, action.payload);
      case 'LOCATION_COUNT':
        return this.locationCount(tx, ctx, action.payload);
    }
  }

  // =====================================================================================
  // Réception et mise en stock (§4.1, REC-01 à REC-04)
  // =====================================================================================

  /** REC-01 : réceptions attendues = collectes enlevées (COLLECTEE) dont des articles restent à ranger. */
  async expectedReceptions(user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT c.id AS "commandeId", c.numero, e.nom AS client, p.nom AS projet, c.statut,
                count(a.id)::int AS "nbArticles",
                count(a.id) FILTER (WHERE a.statut = 'EN_STOCK')::int AS "nbRanges",
                coalesce(json_agg(json_build_object('id', a.id, 'qrCode', a.qr_code, 'libelle', a.libelle, 'statut', a.statut))
                         FILTER (WHERE a.id IS NOT NULL), '[]') AS articles
           FROM commande c
           JOIN entreprise e ON e.id = c.entreprise_id
           LEFT JOIN projet p ON p.id = c.projet_id
           LEFT JOIN article a ON a.commande_collecte_id = c.id
          WHERE c.type = 'COLLECTE' AND c.statut = 'COLLECTEE'
          GROUP BY c.id, e.nom, p.nom
          ORDER BY c.date_confirmee NULLS LAST, c.numero`,
      );
      return r.rows;
    });
  }

  private async articleCreate(tx: Tx, ctx: ActionCtx, p: Extract<FieldAction, { type: 'ARTICLE_CREATE' }>['payload']) {
    const qr = this.qr(p.qr, 'A');
    if (p.photos.length < 1 || p.photos.length > MAX_PHOTOS_PER_ARTICLE) {
      throw unprocessable('PHOTOS', `Entre 1 et ${MAX_PHOTOS_PER_ARTICLE} photos par article (REC-02)`);
    }
    const existing = await tx.query<ArticleRow>('SELECT * FROM article WHERE qr_code = $1 FOR UPDATE', [qr]);
    const quai = await this.receptionDock(tx);
    let articleId: string;

    if (existing.rows[0]) {
      const a = existing.rows[0];
      // §4.1 étape 4 : QR déjà attribué à l'enlèvement → la fiche existe, on la complète
      if (a.statut !== 'ATTENDU') {
        throw conflict(isActiveArticle(a.statut) ? 'QR_DEJA_UTILISE' : 'QR_ARCHIVE', 'QR déjà utilisé par un autre article');
      }
      articleId = a.id;
      await tx.query(
        `UPDATE article SET libelle = $2, categorie_id = coalesce($3, categorie_id), etat = $4, description = coalesce($5, description),
                longueur_m = coalesce($6, longueur_m), largeur_m = coalesce($7, largeur_m), hauteur_m = coalesce($8, hauteur_m),
                poids_kg = coalesce($9, poids_kg), empilable = coalesce($10, empilable)
          WHERE id = $1`,
        [a.id, p.libelle, p.categorieId ?? null, p.etat, p.description ?? null, p.longueurM ?? null, p.largeurM ?? null, p.hauteurM ?? null, p.poidsKg ?? null, p.empilable ?? null],
      );
      await this.move(tx, ctx, a, { type: 'RECEPTION', toLocationId: quai });
    } else if (await this.isProvisional(tx, p.articleId)) {
      // bien enlevé sans étiquette (QR provisoire « P-… ») : on pose l'étiquette définitive à la réception
      await this.claimBlankQr(tx, ctx.user, qr);
      articleId = p.articleId;
      await tx.query(
        `UPDATE article SET qr_code = $2, libelle = $3, categorie_id = coalesce($4, categorie_id), etat = $5, description = coalesce($6, description),
                longueur_m = $7, largeur_m = $8, hauteur_m = $9, poids_kg = coalesce($10, poids_kg), empilable = coalesce($11, empilable)
          WHERE id = $1`,
        [articleId, qr, p.libelle, p.categorieId ?? null, p.etat, p.description ?? null, p.longueurM ?? null, p.largeurM ?? null, p.hauteurM ?? null, p.poidsKg ?? null, p.empilable ?? null],
      );
      const a = (await tx.query<ArticleRow>('SELECT * FROM article WHERE id = $1 FOR UPDATE', [articleId])).rows[0]!;
      await this.move(tx, ctx, a, { type: 'RECEPTION', toLocationId: quai });
    } else {
      await this.claimBlankQr(tx, ctx.user, qr);
      const owner = await this.resolveOwner(tx, p.entrepriseId, p.projetId ?? null, p.commandeId ?? null);
      const dims = await this.categoryDefaults(tx, p.categorieId ?? null);
      articleId = p.articleId;
      await tx.query(
        `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, categorie_id, description, longueur_m, largeur_m,
                              hauteur_m, poids_kg, empilable, etat, statut, commande_collecte_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ATTENDU',$15,$16)`,
        [
          articleId, ctx.user.tenantId, owner.entrepriseId, owner.projetId, qr, p.libelle, p.categorieId ?? null, p.description ?? null,
          p.longueurM ?? dims.longueur_m, p.largeurM ?? dims.largeur_m, p.hauteurM ?? dims.hauteur_m, p.poidsKg ?? null,
          p.empilable ?? dims.empilable, p.etat, p.commandeId ?? null, ctx.user.id,
        ],
      );
      const a = (await tx.query<ArticleRow>('SELECT * FROM article WHERE id = $1', [articleId])).rows[0]!;
      await this.move(tx, ctx, a, { type: 'RECEPTION', toLocationId: quai });
    }
    await this.registerPhotos(tx, ctx, p.photos.map((x) => x.photoId), { articleId, contexte: 'RECEPTION' });
    return { articleId, statut: 'EN_RECEPTION' };
  }

  private async articleStore(tx: Tx, ctx: ActionCtx, p: { articleQr: string; locationQr: string; force?: boolean; motif?: string }) {
    const article = await this.articleByQr(tx, p.articleQr);
    if (article.um_courante_id) throw conflict('DANS_UM', "L'article est sur une UM : scannez l'UM pour la ranger");
    const loc = await this.locationByQr(tx, p.locationQr);
    const photos = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM photo WHERE article_id = $1', [article.id])).rows[0]!.n;
    assertCanStore(photos, loc.statut === 'ACTIF' && loc.adressable); // RG-STK-01
    this.assertStorageZone(loc);
    await this.checkCapacity(tx, ctx, loc, footprint(article), article.poids_kg ?? 0, p.force, p.motif, article.id);
    const type: MovementType = article.statut === 'EN_RECEPTION' || article.statut === 'ATTENDU' ? 'RANGEMENT' : 'TRANSFERT';
    const res = await this.move(tx, ctx, article, { type, toLocationId: loc.id });
    return { articleId: article.id, emplacement: loc.chemin, applique: res.applied };
  }

  private async transfer(tx: Tx, ctx: ActionCtx, p: { qr: string; locationQr: string; motif?: string }) {
    const parsed = parseQr(p.qr);
    if (parsed?.type === 'U') return this.umStore(tx, ctx, { umQr: p.qr, locationQr: p.locationQr });
    return this.articleStore(tx, ctx, { articleQr: p.qr, locationQr: p.locationQr });
  }

  private async umCreate(tx: Tx, ctx: ActionCtx, p: Extract<FieldAction, { type: 'UM_CREATE' }>['payload']) {
    const qr = this.qr(p.qr, 'U');
    await this.claimBlankQr(tx, ctx.user, qr);
    await tx.query(
      `INSERT INTO unite_manutention (id, tenant_id, entreprise_id, type, qr_code, longueur_m, largeur_m, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.umId, ctx.user.tenantId, p.entrepriseId ?? null, p.umType, qr, p.longueurM ?? 1.2, p.largeurM ?? 0.8, ctx.user.id],
    );
    return { umId: p.umId };
  }

  private async umAdd(tx: Tx, _ctx: ActionCtx, p: { umQr: string; articleQr: string }) {
    const um = await this.umByQr(tx, p.umQr);
    const article = await this.articleByQr(tx, p.articleQr);
    if (!['EN_RECEPTION', 'EN_STOCK'].includes(article.statut)) throw conflict('STATUT', `Article au statut ${article.statut}`);
    if (um.entreprise_id && um.entreprise_id !== article.entreprise_id) throw conflict('UM_AUTRE_CLIENT', "L'UM appartient à un autre client");
    if (!um.entreprise_id) await tx.query('UPDATE unite_manutention SET entreprise_id = $2 WHERE id = $1', [um.id, article.entreprise_id]);
    // un article qui rejoint une UM déjà rangée en hérite immédiatement l'emplacement
    await tx.query('UPDATE article SET um_courante_id = $2 WHERE id = $1', [article.id, um.id]);
    return { umId: um.id, articleId: article.id };
  }

  /** REC-04 : scanner l'UM sur un emplacement déplace tous ses articles. */
  private async umStore(tx: Tx, ctx: ActionCtx, p: { umQr: string; locationQr: string; force?: boolean; motif?: string }) {
    const um = await this.umByQr(tx, p.umQr);
    const loc = await this.locationByQr(tx, p.locationQr);
    if (loc.statut !== 'ACTIF' || !loc.adressable) throw unprocessable('EMPLACEMENT_INACTIF', "L'emplacement doit être actif");
    this.assertStorageZone(loc);
    const articles = (await tx.query<ArticleRow>('SELECT * FROM article WHERE um_courante_id = $1 FOR UPDATE', [um.id])).rows;
    for (const a of articles) {
      const photos = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM photo WHERE article_id = $1', [a.id])).rows[0]!.n;
      assertCanStore(photos, true);
    }
    const weight = articles.reduce((s, a) => s + (a.poids_kg ?? 0), 0);
    if (um.emplacement_courant_id !== loc.id) {
      await this.checkCapacity(tx, ctx, loc, um.longueur_m * um.largeur_m, weight, p.force, p.motif);
    }
    const stale = um.dernier_mouvement_terminal && um.dernier_mouvement_terminal > ctx.at;
    if (!stale) {
      await tx.query('UPDATE unite_manutention SET emplacement_courant_id = $2, dernier_mouvement_terminal = $3 WHERE id = $1', [um.id, loc.id, ctx.at]);
    }
    for (const a of articles) {
      const type: MovementType = a.statut === 'EN_RECEPTION' ? 'RANGEMENT' : 'TRANSFERT';
      await this.move(tx, ctx, a, { type, toLocationId: loc.id, umId: um.id });
    }
    return { umId: um.id, emplacement: loc.chemin, nbArticles: articles.length };
  }

  /** Clôture de réception d'une collecte : statut STOCKEE + email récapitulatif (§4.1 effets serveur). */
  private async receptionClose(tx: Tx, ctx: ActionCtx, commandeId: string) {
    const order = await this.orders.load(tx, commandeId, true);
    if (order.type !== 'COLLECTE') throw unprocessable('PAS_UNE_COLLECTE', 'Seule une collecte se clôture en réception');
    const pending = await tx.query<{ n: number; total: number }>(
      `SELECT count(*) FILTER (WHERE statut <> 'EN_STOCK')::int AS n, count(*)::int AS total FROM article WHERE commande_collecte_id = $1`,
      [commandeId],
    );
    const { n, total } = pending.rows[0]!;
    if (n > 0) throw conflict('ARTICLES_NON_RANGES', `${n} article(s) pas encore rangé(s)`);
    await this.orders.setStatus(tx, ctx.user, order, 'STOCKEE');
    await this.notifyClient(tx, ctx.user, order, 'ARTICLES_MIS_EN_STOCK', { nbArticles: total });
    return { commandeId, statut: 'STOCKEE', nbArticles: total };
  }

  /** Retour au dépôt d'un article refusé ou non livré : il repasse en réception pour être rangé. */
  private async returnToDepot(tx: Tx, ctx: ActionCtx, p: { articleQr: string; locationQr?: string; motif?: string }) {
    const article = await this.articleByQr(tx, p.articleQr);
    const quai = p.locationQr ? (await this.locationByQr(tx, p.locationQr)).id : await this.receptionDock(tx);
    await this.move(tx, ctx, article, { type: 'RETOUR', toLocationId: quai, motif: p.motif });
    await tx.query(`UPDATE ligne_commande SET active = false WHERE article_id = $1 AND active`, [article.id]);
    return { articleId: article.id, statut: 'EN_RECEPTION' };
  }

  // =====================================================================================
  // Préparation et chargement (PRP-01 à PRP-03)
  // =====================================================================================

  /** PRP-01 : liste de prélèvement triée par chemin, avec vignette. LIV-01 : arrêt avec adresse et contraintes. */
  async missionDetail(user: AuthUser, missionId: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const mission = await this.mission(tx, user, missionId, false);
      const order = mission.commande_id ? (await tx.query('SELECT * FROM commande WHERE id = $1', [mission.commande_id])).rows[0] : null;
      const lignes = mission.commande_id
        ? (
            await tx.query<{ chemin: string | null; vignette: string | null }>(
              `SELECT l.id, l.article_id AS "articleId", l.statut_ligne AS "statutLigne", l.description_libre AS "descriptionLibre",
                      a.qr_code AS "qrCode", a.libelle, a.statut, e.chemin, e.code AS "emplacementCode",
                      (SELECT p.id FROM photo p WHERE p.article_id = a.id AND p.televersee ORDER BY p.prise_le LIMIT 1) AS vignette,
                      ud.qr_code AS "umADegrouper", (l.um_a_degrouper IS NOT NULL AND a.um_courante_id = l.um_a_degrouper) AS "resteSurUm"
                 FROM ligne_commande l
                 LEFT JOIN article a ON a.id = l.article_id
                 LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id
                 LEFT JOIN unite_manutention ud ON ud.id = l.um_a_degrouper
                WHERE l.commande_id = $1`,
              [mission.commande_id],
            )
          ).rows
        : [];
      return {
        id: mission.id,
        type: mission.type,
        statut: mission.statut,
        commande: order && {
          id: order.id,
          numero: order.numero,
          type: order.type,
          statut: order.statut,
          adresse: order.adresse,
          contraintesAcces: order.contraintes_acces,
          contactSite: order.contact_site,
          dateConfirmee: order.date_confirmee,
          creneau: order.creneau_confirme,
          depotSansSignature: order.depot_sans_signature,
        },
        lignes: sortByPath(lignes).map((l) => ({ ...l, vignette: l.vignette ? this.files.photoUrl(user.tenantId, l.vignette, 't') : null })),
        demande: mission.type === 'PHOTO' ? await this.photoRequestInfo(tx, user, mission) : null,
        comptage: mission.type === 'INVENTAIRE' ? await this.countInfo(tx, mission) : null,
      };
    });
  }

  // =====================================================================================
  // Aides à la réception : suggestion d'emplacement (REC-06), duplication (REC-05)
  // =====================================================================================

  /**
   * REC-06 : emplacements libres où l'article tient (surface restante, hauteur), en zone de stockage,
   * non réservés à un autre client. Priorité au regroupement par projet (O5) : même emplacement,
   * puis même allée, puis même zone ; ensuite au meilleur ajustement pour ne pas gâcher la place.
   */
  async suggestLocations(
    user: AuthUser,
    q: { articleId?: string; commandeId?: string; entrepriseId?: string; projetId?: string | null; longueurM?: number; largeurM?: number; hauteurM?: number; empilable?: boolean },
  ) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const a = q.articleId
        ? (await tx.query<ArticleRow & { hauteur_m: number | null }>('SELECT * FROM article WHERE id = $1', [q.articleId])).rows[0]
        : undefined;
      let owner: { entrepriseId: string | null; projetId: string | null } = { entrepriseId: a?.entreprise_id ?? q.entrepriseId ?? null, projetId: a?.projet_id ?? q.projetId ?? null };
      if (!a && q.commandeId) {
        const c = (await tx.query<{ entreprise_id: string; projet_id: string | null }>('SELECT entreprise_id, projet_id FROM commande WHERE id = $1', [q.commandeId])).rows[0];
        if (c) owner = { entrepriseId: c.entreprise_id, projetId: c.projet_id };
      }
      const l = a?.longueur_m ?? q.longueurM ?? null;
      const w = a?.largeur_m ?? q.largeurM ?? null;
      const h = a?.hauteur_m ?? q.hauteurM ?? null;
      const need = l != null && w != null ? l * w * ((a?.empilable ?? q.empilable) ? 0.5 : 1) : 0;
      const rows = (
        await tx.query<{
          id: string; code: string; chemin: string; qr_code: string; surface_m2: number; hauteur_m: number | null; dedie: boolean;
          occupe_m2: number; nb_articles: number; meme_projet: number; meme_client: number; projet_allee: number; projet_zone: number;
        }>(
          `SELECT e.id, e.code, e.chemin, e.qr_code, e.surface_m2::float AS surface_m2, e.hauteur_m::float AS hauteur_m,
                  (e.dedie_entreprise_id IS NOT NULL) AS dedie, ${usageColumns('e')},
                  (SELECT count(*)::int FROM article x WHERE x.emplacement_courant_id = e.id AND x.statut IN ('EN_STOCK','RESERVE') AND x.projet_id = $2) AS meme_projet,
                  (SELECT count(*)::int FROM article x WHERE x.emplacement_courant_id = e.id AND x.statut IN ('EN_STOCK','RESERVE') AND x.entreprise_id = $1) AS meme_client,
                  (SELECT count(*)::int FROM article x JOIN emplacement s ON s.id = x.emplacement_courant_id
                    WHERE s.parent_id = e.parent_id AND e.parent_id IS NOT NULL AND x.statut IN ('EN_STOCK','RESERVE') AND x.projet_id = $2) AS projet_allee,
                  (SELECT count(*)::int FROM article x JOIN emplacement s ON s.id = x.emplacement_courant_id
                    WHERE s.zone_id = e.zone_id AND x.statut IN ('EN_STOCK','RESERVE') AND x.projet_id = $2) AS projet_zone
             FROM emplacement e JOIN zone z ON z.id = e.zone_id
            WHERE z.type = 'STOCKAGE' AND e.adressable AND e.statut = 'ACTIF'
              AND (e.dedie_entreprise_id IS NULL OR e.dedie_entreprise_id = $1)`,
          [owner.entrepriseId, owner.projetId],
        )
      ).rows;
      const scored = rows
        .map((r) => {
          const libre = r.surface_m2 > 0 ? r.surface_m2 - r.occupe_m2 : null;
          if (libre != null && libre + 1e-4 < need) return null;
          if (h != null && r.hauteur_m != null && h > r.hauteur_m + 1e-4) return null;
          // sans surface déclarée, on ne propose qu'un emplacement vide
          if (libre == null && r.nb_articles > 0 && !r.meme_projet) return null;
          const projet = !!owner.projetId;
          const raison =
            projet && r.meme_projet ? 'Le même projet est déjà rangé ici'
            : projet && r.projet_allee ? 'À côté des biens du même projet'
            : r.dedie ? 'Emplacement réservé à ce client'
            : r.meme_client ? 'Ce client a déjà des biens ici'
            : projet && r.projet_zone ? 'Dans la zone du même projet'
            : 'Emplacement libre adapté';
          const score =
            (projet && r.meme_projet ? 1000 : 0) + (projet && r.projet_allee ? 400 : 0) + (r.dedie ? 300 : 0) + (r.meme_client ? 150 : 0) +
            (projet && r.projet_zone ? 60 : 0) - (libre == null ? 20 : Math.min(libre - need, 50));
          return { id: r.id, code: r.code, chemin: r.chemin, qrCode: r.qr_code, libreM2: libre == null ? null : Math.round(libre * 100) / 100, raison, score };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((x, y) => y.score - x.score || x.chemin.localeCompare(y.chemin, 'fr', { numeric: true }));
      return { besoinM2: Math.round(need * 100) / 100, suggestions: scored.slice(0, 3).map(({ score: _s, ...x }) => x) };
    });
  }

  /**
   * REC-05 : « encore 11 comme celui-ci ». Chaque copie reprend catégorie, libellé, description, dimensions,
   * état et photos du modèle, avec son propre QR ; elles attendent au quai de réception d'être étiquetées et rangées.
   */
  async duplicate(user: AuthUser, articleId: string, nombre: number) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const src = (await tx.query<ArticleRow & Record<string, unknown>>('SELECT * FROM article WHERE id = $1', [articleId])).rows[0];
      if (!src) throw notFound('Article modèle (synchronisez d’abord la réception)');
      if (!['EN_RECEPTION', 'EN_STOCK', 'RESERVE'].includes(src.statut)) throw conflict('STATUT', `Article ${src.statut} : il ne peut pas servir de modèle`);
      const photos = (
        await tx.query<{ id: string; cle_originale: string; cle_vignette: string | null; cle_moyenne: string | null; type_mime: string | null; taille_octets: number | null; televersee: boolean }>(
          `SELECT id, cle_originale, cle_vignette, cle_moyenne, type_mime, taille_octets, televersee FROM photo
            WHERE article_id = $1 AND contexte IN ('RECEPTION','ENLEVEMENT') ORDER BY prise_le LIMIT $2`,
          [src.id, MAX_PHOTOS_PER_ARTICLE],
        )
      ).rows;
      if (!photos.length) throw unprocessable('PHOTOS', 'Le modèle n’a pas encore de photo : impossible de le dupliquer');
      const quai = await this.receptionDock(tx);
      const ctx: ActionCtx = { user, deviceId: 'terminal', at: new Date(), warnings: [] };
      const out: { id: string; qrCode: string }[] = [];
      for (let i = 0; i < nombre; i++) {
        const id = uuidv7();
        const qr = generateQrCode('A');
        await tx.query(
          `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, categorie_id, description, longueur_m, largeur_m,
                                hauteur_m, poids_kg, empilable, etat, statut, commande_collecte_id, created_by)
           SELECT $1, tenant_id, entreprise_id, projet_id, $2, libelle, categorie_id, description, longueur_m, largeur_m,
                  hauteur_m, poids_kg, empilable, etat, 'ATTENDU', commande_collecte_id, $3
             FROM article WHERE id = $4`,
          [id, qr, user.id, src.id],
        );
        const copy = (await tx.query<ArticleRow>('SELECT * FROM article WHERE id = $1', [id])).rows[0]!;
        await this.move(tx, ctx, copy, { type: 'RECEPTION', toLocationId: quai, motif: `Copie de ${src.qr_code}` });
        for (const p of photos) {
          await tx.query(
            `INSERT INTO photo (id, tenant_id, article_id, cle_originale, cle_vignette, cle_moyenne, type_mime, taille_octets, contexte, prise_le, prise_par, televersee, copie_de)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RECEPTION',now(),$9,$10,$11)`,
            [uuidv7(), user.tenantId, id, p.cle_originale, p.cle_vignette, p.cle_moyenne, p.type_mime, p.taille_octets, user.id, p.televersee, p.id],
          );
        }
        out.push({ id, qrCode: qr });
      }
      await this.audit.record(tx, user, {
        action: 'ARTICLE_DUPLIQUE',
        objet: 'article',
        objetId: src.id,
        entrepriseId: src.entreprise_id,
        apres: { copies: out.map((x) => x.qrCode) },
      });
      return { source: { id: src.id, qrCode: src.qr_code, libelle: src.libelle }, articles: out };
    });
  }

  // =====================================================================================
  // Inventaire tournant (WMS-05) : comptage en aveugle, emplacement par emplacement
  // =====================================================================================

  private async countInfo(tx: Tx, mission: MissionRow) {
    const r = await tx.query<{ id: string; code: string; chemin: string; qrCode: string; compte: boolean; trouves: number }>(
      `SELECT e.id, e.code, e.chemin, e.qr_code AS "qrCode", c.compte_le IS NOT NULL AS compte,
              cardinality(c.trouves) + cardinality(c.inconnus) AS trouves
         FROM inventaire_comptage c JOIN emplacement e ON e.id = c.emplacement_id
        WHERE c.mission_id = $1 ORDER BY c.ordre`,
      [mission.id],
    );
    const d = mission.donnees as { numero?: string; zone?: string; partie?: number };
    return { numero: d.numero ?? null, zone: d.zone ?? null, partie: d.partie ?? 1, emplacements: r.rows };
  }

  /**
   * L'opérateur scanne l'emplacement puis tout ce qui s'y trouve. Le stock attendu n'est pas montré
   * (comptage en aveugle) ; il est figé au moment du comptage et comparé : manquants, articles trouvés
   * ailleurs que là où le système les plaçait, étiquettes inconnues. Rien n'est corrigé ici : les écarts
   * sont arbitrés au Back-Office. Recompter un emplacement remplace son comptage précédent.
   */
  private async locationCount(tx: Tx, ctx: ActionCtx, p: { missionId: string; locationQr: string; qrs: string[] }) {
    // un emplacement peut être recompté tant que l'inventaire est ouvert, même si la mission est finie
    const m = await this.mission(tx, ctx.user, p.missionId, false, ['INVENTAIRE']);
    await tx.query('SELECT 1 FROM mission WHERE id = $1 FOR UPDATE', [m.id]);
    const loc = await this.locationByQr(tx, p.locationQr);
    const c = (
      await tx.query<{ id: string; inventaire_id: string }>('SELECT id, inventaire_id FROM inventaire_comptage WHERE mission_id = $1 AND emplacement_id = $2 FOR UPDATE', [m.id, loc.id])
    ).rows[0];
    if (!c) throw unprocessable('HORS_INVENTAIRE', `L’emplacement ${loc.code} ne fait pas partie de ce comptage`);
    const inv = (await tx.query<{ statut: string }>('SELECT statut FROM inventaire WHERE id = $1 FOR UPDATE', [c.inventaire_id])).rows[0]!;
    if (inv.statut !== 'EN_COURS') throw conflict('INVENTAIRE_CLOS', 'Cet inventaire n’est plus en cours de comptage');
    if (m.statut === 'AFFECTEE' || m.statut === 'A_AFFECTER') await this.startMission(tx, ctx, m);

    const attendus = (
      await tx.query<{ id: string }>(`SELECT id FROM article WHERE emplacement_courant_id = $1 AND statut IN ('EN_STOCK','RESERVE')`, [loc.id])
    ).rows.map((r) => r.id);
    const trouves = new Set<string>();
    const inconnus = new Set<string>();
    for (const raw of p.qrs) {
      const q = parseQr(raw);
      if (q?.type === 'U') {
        const u = await tx.query<{ id: string }>('SELECT a.id FROM article a JOIN unite_manutention u ON u.id = a.um_courante_id WHERE u.qr_code = $1', [q.qr]);
        if (!u.rowCount) inconnus.add(q.qr);
        for (const a of u.rows) trouves.add(a.id);
      } else if (q?.type === 'A') {
        const a = (await tx.query<{ id: string }>('SELECT id FROM article WHERE qr_code = $1', [q.qr])).rows[0];
        if (a) trouves.add(a.id);
        else inconnus.add(q.qr);
      } else {
        inconnus.add(raw.trim().slice(0, 200));
      }
    }
    await tx.query('DELETE FROM inventaire_ecart WHERE inventaire_id = $1 AND emplacement_id = $2 AND decision IS NULL', [c.inventaire_id, loc.id]);
    const ecart = (type: string, articleId: string | null, qr: string | null, systeme: string | null) =>
      tx.query(
        `INSERT INTO inventaire_ecart (id, tenant_id, inventaire_id, emplacement_id, type, article_id, qr, emplacement_systeme_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), ctx.user.tenantId, c.inventaire_id, loc.id, type, articleId, qr, systeme],
      );
    let n = 0;
    for (const id of attendus) if (!trouves.has(id)) (await ecart('MANQUANT', id, null, loc.id), n++);
    const extra = [...trouves].filter((id) => !attendus.includes(id));
    if (extra.length) {
      const rows = (await tx.query<{ id: string; emplacement_courant_id: string | null }>('SELECT id, emplacement_courant_id FROM article WHERE id = ANY($1)', [extra])).rows;
      for (const a of rows) (await ecart('DEPLACE', a.id, null, a.emplacement_courant_id), n++);
    }
    for (const qr of inconnus) (await ecart('INCONNU', null, qr, null), n++);
    await tx.query('UPDATE inventaire_comptage SET attendus = $2, trouves = $3, inconnus = $4, compte_le = $5, compte_par = $6 WHERE id = $1', [
      c.id, attendus, [...trouves], [...inconnus], ctx.at, ctx.user.id,
    ]);

    const left = (await tx.query<{ mission: number; total: number }>(
      `SELECT count(*) FILTER (WHERE mission_id = $2 AND compte_le IS NULL)::int AS mission, count(*) FILTER (WHERE compte_le IS NULL)::int AS total
         FROM inventaire_comptage WHERE inventaire_id = $1`,
      [c.inventaire_id, m.id],
    )).rows[0]!;
    if (!left.mission && m.statut !== 'TERMINEE') await this.finishMission(tx, ctx, m);
    if (!left.total) {
      const ecarts = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM inventaire_ecart WHERE inventaire_id = $1 AND decision IS NULL', [c.inventaire_id])).rows[0]!.n;
      await tx.query(
        `UPDATE inventaire SET statut = $2, termine_le = now(), clos_le = CASE WHEN $2 = 'CLOS' THEN now() END WHERE id = $1`,
        [c.inventaire_id, ecarts ? 'A_ARBITRER' : 'CLOS'],
      );
      if (ecarts) await this.notifyStaff(tx, ctx.user, 'SUPER_ADMIN', 'INVENTAIRE_A_ARBITRER', { inventaireId: c.inventaire_id, numero: (m.donnees as { numero?: string }).numero, ecarts });
    }
    return { emplacement: loc.code, attendus: attendus.length, trouves: trouves.size, ecarts: n, restants: left.mission, termine: !left.mission };
  }

  private async pick(tx: Tx, ctx: ActionCtx, p: { missionId: string; articleQr: string }) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['PREPARATION']);
    const order = await this.orders.load(tx, mission.commande_id!, true);
    const article = await this.articleByQr(tx, p.articleQr);
    const line = await tx.query<{ id: string; statut_ligne: string; um_a_degrouper: string | null }>(
      'SELECT id, statut_ligne, um_a_degrouper FROM ligne_commande WHERE commande_id = $1 AND article_id = $2 FOR UPDATE',
      [order.id, article.id],
    );
    // PRP-02 : article hors commande = alerte bloquante
    if (!line.rows[0]) throw conflict('HORS_COMMANDE', `« ${article.libelle} » ne fait pas partie de cette commande`);
    // CMD-09 : un article demandé seul part sans le reste de son UM ; le dégroupage passe avant
    if (line.rows[0].um_a_degrouper && article.um_courante_id === line.rows[0].um_a_degrouper) {
      throw conflict('DEGROUPAGE_REQUIS', `« ${article.libelle} » est encore sur son UM : faites d’abord la mission de dégroupage`);
    }
    if (line.rows[0].statut_ligne === 'PREPAREE') return { articleId: article.id, dejaPrepare: true };
    if (order.statut === 'PLANIFIEE') await this.orders.setStatus(tx, ctx.user, order, 'EN_PREPARATION');
    await this.startMission(tx, ctx, mission);
    await this.move(tx, ctx, article, { type: 'PREPARATION', missionId: mission.id });
    await tx.query(`UPDATE ligne_commande SET statut_ligne = 'PREPAREE' WHERE id = $1`, [line.rows[0].id]);
    return { articleId: article.id, ...(await this.progress(tx, order.id, ['PREPAREE', 'CHARGEE'])) };
  }

  /**
   * CMD-09 : l'opérateur sort de son UM un article demandé seul. L'article reste à son emplacement, hors UM ;
   * les autres articles restent sur l'UM. La mission se termine quand tous les articles demandés sont sortis.
   */
  private async umSplit(tx: Tx, ctx: ActionCtx, p: { missionId: string; articleQr: string }) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['DEGROUPAGE']);
    const article = await this.articleByQr(tx, p.articleQr);
    const line = (
      await tx.query<{ id: string; um_a_degrouper: string | null }>(
        'SELECT id, um_a_degrouper FROM ligne_commande WHERE commande_id = $1 AND article_id = $2 AND active',
        [mission.commande_id, article.id],
      )
    ).rows[0];
    if (!line?.um_a_degrouper) throw conflict('HORS_DEGROUPAGE', `« ${article.libelle} » n’est pas à sortir de son UM pour cette commande`);
    await this.startMission(tx, ctx, mission);
    if (article.um_courante_id === line.um_a_degrouper) {
      const order = await this.orders.load(tx, mission.commande_id!);
      await tx.query(
        `INSERT INTO mouvement (id, tenant_id, article_id, um_id, type, de_emplacement_id, vers_emplacement_id, statut_avant, statut_apres,
                                mission_id, auteur_id, appareil_id, horodatage_terminal, motif)
         VALUES ($1,$2,$3,$4,'AJUSTEMENT',$5,$5,$6,$6,$7,$8,$9,$10,$11)`,
        [uuidv7(), ctx.user.tenantId, article.id, line.um_a_degrouper, article.emplacement_courant_id, article.statut, mission.id, ctx.user.id, ctx.deviceId, ctx.at, `Dégroupage pour la commande ${order.numero ?? ''}`.trim()],
      );
      await tx.query('UPDATE article SET um_courante_id = NULL, dernier_mouvement_le = now() WHERE id = $1', [article.id]);
    }
    const left = (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ligne_commande l JOIN article a ON a.id = l.article_id
          WHERE l.commande_id = $1 AND l.active AND l.um_a_degrouper IS NOT NULL AND a.um_courante_id = l.um_a_degrouper`,
        [mission.commande_id],
      )
    ).rows[0]!.n;
    if (left === 0) await this.finishMission(tx, ctx, mission);
    return { articleId: article.id, restants: left, termine: left === 0 };
  }

  /** PRP-02 : article introuvable → anomalie avec photo de l'emplacement vide, notifiée au Dispatcher. */
  private async pickMissing(tx: Tx, ctx: ActionCtx, p: { missionId: string; articleId: string; photoId?: string; commentaire?: string }) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['PREPARATION']);
    const upd = await tx.query(
      `UPDATE ligne_commande SET statut_ligne = 'MANQUANTE', active = false
        WHERE commande_id = $1 AND article_id = $2 AND statut_ligne = 'DEMANDEE'`,
      [mission.commande_id, p.articleId],
    );
    if (!upd.rowCount) throw notFound('Ligne à préparer');
    if (p.photoId) await this.registerPhotos(tx, ctx, [p.photoId], { articleId: p.articleId, contexte: 'ANOMALIE' });
    await tx.query(`UPDATE article SET statut = 'EN_STOCK' WHERE id = $1 AND statut = 'RESERVE'`, [p.articleId]);
    await this.alert(tx, ctx.user, 'ARTICLE_INTROUVABLE', { articleId: p.articleId, missionId: mission.id, details: { commentaire: p.commentaire ?? null } });
    await this.notifyStaff(tx, ctx.user, 'DISPATCHER', 'ANOMALIE_PREPARATION', { commandeId: mission.commande_id, articleId: p.articleId });
    return { articleId: p.articleId, statutLigne: 'MANQUANTE' };
  }

  private async pickComplete(tx: Tx, ctx: ActionCtx, missionId: string) {
    const mission = await this.mission(tx, ctx.user, missionId, true, ['PREPARATION']);
    const order = await this.orders.load(tx, mission.commande_id!, true);
    const left = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ligne_commande WHERE commande_id = $1 AND statut_ligne = 'DEMANDEE'`,
      [order.id],
    );
    if (left.rows[0]!.n > 0) throw conflict('PREPARATION_INCOMPLETE', `${left.rows[0]!.n} article(s) ni prélevé(s) ni déclaré(s) manquant(s)`);
    if (order.statut === 'PLANIFIEE') await this.orders.setStatus(tx, ctx.user, order, 'EN_PREPARATION');
    await this.orders.setStatus(tx, ctx.user, order, 'PRETE');
    await this.finishMission(tx, ctx, mission);
    return { commandeId: order.id, statut: 'PRETE' };
  }

  /** PRP-03 : scan au chargement → statut « En transit ». */
  private async load(tx: Tx, ctx: ActionCtx, p: { missionId: string; articleQr: string }) {
    // le chargement suit la préparation (mission déjà terminée) : on verrouille la commande, pas la mission
    const mission = await this.mission(tx, ctx.user, p.missionId, false, ['PREPARATION', 'LIVRAISON']);
    const order = await this.orders.load(tx, mission.commande_id!, true);
    if (order.statut !== 'PRETE') throw conflict('PAS_PRETE', 'La commande doit être prête avant le chargement');
    const article = await this.articleByQr(tx, p.articleQr);
    const line = await tx.query<{ id: string; statut_ligne: string }>(
      'SELECT id, statut_ligne FROM ligne_commande WHERE commande_id = $1 AND article_id = $2 FOR UPDATE',
      [order.id, article.id],
    );
    if (!line.rows[0]) throw conflict('HORS_COMMANDE', `« ${article.libelle} » ne fait pas partie de cette commande`);
    if (line.rows[0].statut_ligne === 'CHARGEE') return { articleId: article.id, dejaCharge: true };
    if (line.rows[0].statut_ligne !== 'PREPAREE') throw conflict('NON_PREPARE', "L'article n'a pas été préparé");
    await this.move(tx, ctx, article, { type: 'CHARGEMENT', missionId: mission.id });
    await tx.query(`UPDATE ligne_commande SET statut_ligne = 'CHARGEE' WHERE id = $1`, [line.rows[0].id]);
    return { articleId: article.id, ...(await this.progress(tx, order.id, ['CHARGEE'])) };
  }

  // =====================================================================================
  // Livraison, collecte et preuve de dépôt (§4.3, LIV-01 à LIV-06)
  // =====================================================================================

  private async depart(tx: Tx, ctx: ActionCtx, missionId: string) {
    const mission = await this.mission(tx, ctx.user, missionId, true, ['LIVRAISON', 'COLLECTE']);
    if (mission.type === 'LIVRAISON') {
      const order = await this.orders.load(tx, mission.commande_id!, true);
      // PRP-03 : impossible de partir avec des articles préparés non chargés
      const notLoaded = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ligne_commande WHERE commande_id = $1 AND statut_ligne = 'PREPAREE'`,
        [order.id],
      );
      if (notLoaded.rows[0]!.n > 0) throw conflict('CHARGEMENT_INCOMPLET', `${notLoaded.rows[0]!.n} article(s) préparé(s) non chargé(s)`);
      await this.orders.setStatus(tx, ctx.user, order, 'EN_LIVRAISON');
      // LIV-02 (SMS + lien de suivi) arrive en phase 1.5 ; la notification est déjà mise en file
      await this.notifyClient(tx, ctx.user, order, 'CHAUFFEUR_EN_ROUTE', {});
    }
    await this.startMission(tx, ctx, mission, { enRouteLe: ctx.at.toISOString() });
    return { missionId, statut: 'EN_COURS' };
  }

  private async arrive(tx: Tx, ctx: ActionCtx, p: { missionId: string; gps?: { lat: number; lng: number; precision?: number } }) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['LIVRAISON', 'COLLECTE']);
    const order = mission.commande_id ? await this.orders.load(tx, mission.commande_id) : null;
    const target = (order as unknown as { adresse?: { lat?: number; lng?: number } } | null)?.adresse;
    let distance: number | null = null;
    if (p.gps && target?.lat !== undefined && target?.lng !== undefined) {
      distance = Math.round(haversineMeters(p.gps, { lat: target.lat, lng: target.lng }));
      if (distance > ARRIVAL_MAX_DISTANCE_M) {
        ctx.warnings.push(`Position à ${distance} m de l'adresse de livraison`);
        await this.alert(tx, ctx.user, 'GPS_ELOIGNE', { missionId: mission.id, details: { distance, gps: p.gps } });
      }
    }
    await tx.query(`UPDATE mission SET donnees = donnees || $2::jsonb WHERE id = $1`, [
      mission.id,
      JSON.stringify({ arriveLe: ctx.at.toISOString(), arriveGps: p.gps ?? null, distanceAdresseM: distance }),
    ]);
    return { missionId: mission.id, distanceM: distance };
  }

  /**
   * LIV-03 / LIV-04 : signature du BL. Le serveur recalcule l'empreinte SHA-256 du contenu signé et refuse
   * un BL altéré. Couvre la livraison et le retrait au comptoir (variante §4.2).
   */
  private async blSign(tx: Tx, ctx: ActionCtx, p: Extract<FieldAction, { type: 'BL_SIGN' }>['payload']) {
    const isPickupAtDepot = await this.peekMissionType(tx, p.missionId);
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['LIVRAISON', 'RETRAIT'], isPickupAtDepot === 'RETRAIT' ? 'stock.move' : undefined);
    const order = await this.orders.load(tx, mission.commande_id!, true);
    const depot = p.depot;
    if (depot) {
      // LIV-05 : seulement si le client l'a autorisé pour cette commande, avec au moins 3 photos du dépôt
      if (mission.type !== 'LIVRAISON' || !order.depot_sans_signature) {
        throw conflict('DEPOT_NON_AUTORISE', 'Le client n’a pas autorisé la livraison sans signature : prévoyez un retour au dépôt');
      }
      if (depot.photoIds.length < 3) throw unprocessable('PHOTOS', 'Trois photos du dépôt au minimum');
      if (p.refuses.length || p.reserves.length) throw unprocessable('DEPOT_SANS_REFUS', 'Sans destinataire, pas de refus ni de réserve : tous les articles sont déposés');
    } else {
      if (!p.signataire.nom.trim() || !p.signataire.qualite.trim()) throw unprocessable('SIGNATAIRE', 'Nom et qualité du signataire obligatoires');
      if (!p.signatureSvg.trim()) throw unprocessable('SIGNATURE', 'Signature manquante');
    }
    const expected = blFingerprint(p);
    if (expected !== p.empreinte) throw conflict('EMPREINTE_INVALIDE', "L'empreinte du BL ne correspond pas à son contenu");

    const retrait = mission.type === 'RETRAIT';
    const expectedStatus: OrderStatus = retrait ? 'PRETE' : 'EN_LIVRAISON';
    if (order.statut !== expectedStatus) throw conflict('STATUT', `Commande au statut ${order.statut}`);

    const lines = (
      await tx.query<{ article_id: string; statut_ligne: string }>(
        `SELECT article_id, statut_ligne FROM ligne_commande WHERE commande_id = $1 AND article_id IS NOT NULL AND statut_ligne <> 'MANQUANTE'`,
        [order.id],
      )
    ).rows;
    const expectedIds = new Set(lines.map((l) => l.article_id));
    const declared = [...p.livres, ...p.refuses];
    if (new Set(declared).size !== declared.length) throw unprocessable('DOUBLON', 'Un article est à la fois livré et refusé');
    const unknown = declared.filter((id) => !expectedIds.has(id));
    if (unknown.length) throw conflict('HORS_COMMANDE', `Articles hors commande : ${unknown.join(', ')}`);
    const missing = [...expectedIds].filter((id) => !declared.includes(id));
    if (missing.length) throw unprocessable('ARTICLES_NON_POINTES', `${missing.length} article(s) ni livré(s) ni refusé(s)`);
    for (const r of p.reserves) if (!expectedIds.has(r.articleId)) throw conflict('HORS_COMMANDE', `Réserve sur un article hors commande`);

    const allRefused = p.livres.length === 0;
    const year = ctx.at.getUTCFullYear();
    const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [ctx.user.tenantId, 'BL', year])).rows[0]!.n;
    const numero = formatDocumentNumber('BL', year, seq);
    const blType = allRefused ? 'REFUS' : retrait ? 'RETRAIT' : 'LIVRAISON';
    await tx.query(
      `INSERT INTO bon_de_livraison (id, tenant_id, numero, mission_id, commande_id, entreprise_id, type, contenu, signataire_nom, signataire_qualite,
                                     signature_svg, signe_le, latitude, longitude, precision_m, appareil_id, empreinte_sha256, statut, lieu_depot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        p.blId, ctx.user.tenantId, numero, mission.id, order.id, order.entreprise_id, blType, JSON.stringify(blContent(p)),
        depot ? null : p.signataire.nom, depot ? null : p.signataire.qualite, depot ? null : p.signatureSvg, p.signedAt, p.gps?.lat ?? null, p.gps?.lng ?? null,
        p.gps?.precision ?? null, ctx.deviceId, expected, depot ? 'NON_SIGNE_DEPOSE' : 'SIGNE', depot?.lieu ?? null,
      ],
    );
    if (depot) {
      for (const id of depot.photoIds) {
        await tx.query(
          `INSERT INTO photo (id, tenant_id, article_id, bl_id, cle_originale, contexte, prise_le, prise_par)
           VALUES ($1,$2,NULL,$3,$4,'DEPOT',$5,$6) ON CONFLICT (id) DO NOTHING`,
          [id, ctx.user.tenantId, p.blId, `${ctx.user.tenantId}/photos/${id}`, ctx.at, ctx.user.id],
        );
      }
    }
    for (const r of p.reserves) {
      await tx.query('INSERT INTO reserve (id, tenant_id, bl_id, article_id, type, commentaire, photo_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        uuidv7(), ctx.user.tenantId, p.blId, r.articleId, r.type, r.commentaire ?? null, r.photoIds ?? [],
      ]);
      if (r.photoIds?.length) await this.registerPhotos(tx, ctx, r.photoIds, { articleId: r.articleId, contexte: 'RESERVE', blId: p.blId });
    }

    for (const id of p.livres) {
      const a = (await tx.query<ArticleRow>('SELECT * FROM article WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      let current = a;
      if (retrait && a.statut === 'EN_PREPARATION') {
        await this.move(tx, ctx, current, { type: 'CHARGEMENT', missionId: mission.id });
        current = (await tx.query<ArticleRow>('SELECT * FROM article WHERE id = $1', [id])).rows[0]!;
      }
      await this.move(tx, ctx, current, { type: 'LIVRAISON', missionId: mission.id });
      await tx.query(`UPDATE ligne_commande SET statut_ligne = 'LIVREE', active = false WHERE commande_id = $1 AND article_id = $2`, [order.id, id]);
    }
    // un article refusé repart au dépôt (statut Retour dépôt) : il reste « en transit » jusqu'au scan RETURN
    for (const id of p.refuses) {
      await tx.query(`UPDATE ligne_commande SET statut_ligne = 'REFUSEE' WHERE commande_id = $1 AND article_id = $2`, [order.id, id]);
    }

    const withReserves = p.reserves.length > 0 || p.refuses.length > 0;
    const next: OrderStatus = retrait ? 'RETIREE' : allRefused ? 'ECHEC_LIVRAISON' : withReserves ? 'LIVREE_AVEC_RESERVES' : 'LIVREE';
    await this.orders.setStatus(tx, ctx.user, order, next);
    await this.finishMission(tx, ctx, mission);
    if (!retrait && !allRefused) await this.recordDeliveryService(tx, ctx, order, mission.id);
    // le PDF scellé (PDF/A + cachet serveur) est produit par le worker documents (phase D)
    await this.notifyClient(tx, ctx.user, order, 'LIVRAISON_EFFECTUEE', { blId: p.blId, numero, ...(depot ? { nonSigne: true, lieuDepot: depot.lieu } : {}) });
    await this.audit.record(tx, ctx.user, {
      action: 'BL_SIGNE',
      objet: 'bon_de_livraison',
      objetId: p.blId,
      entrepriseId: order.entreprise_id,
      apres: { numero, empreinte: expected, livres: p.livres.length, refuses: p.refuses.length, reserves: p.reserves.length, ...(depot ? { nonSigneDepose: depot.lieu } : {}) },
    });
    return { blId: p.blId, numero, empreinte: expected, statutCommande: next };
  }

  /** LIV-06 : collecte chez le client avec BL d'enlèvement signé ; les articles sont créés ATTENDU. */
  private async pickupSign(tx: Tx, ctx: ActionCtx, p: Extract<FieldAction, { type: 'PICKUP_SIGN' }>['payload']) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['COLLECTE']);
    const order = await this.orders.load(tx, mission.commande_id!, true);
    if (order.statut !== 'PLANIFIEE') throw conflict('STATUT', `Commande au statut ${order.statut}`);
    if (p.articles.length === 0) throw unprocessable('AUCUN_ARTICLE', 'Aucun bien enlevé');
    if (!p.signataire.nom.trim() || !p.signatureSvg.trim()) throw unprocessable('SIGNATURE', 'Signature et nom du signataire obligatoires');
    const expected = pickupFingerprint(p);
    if (expected !== p.empreinte) throw conflict('EMPREINTE_INVALIDE', "L'empreinte du BL ne correspond pas à son contenu");

    for (const a of p.articles) {
      const qr = a.qr ? this.qr(a.qr, 'A') : null;
      if (qr) await this.claimBlankQr(tx, ctx.user, qr);
      await tx.query(
        `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, categorie_id, statut, commande_collecte_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ATTENDU',$8,$9)`,
        // sans étiquette sur site, un QR provisoire interne est attribué ; l'étiquette définitive se pose à la réception
        [a.articleId, ctx.user.tenantId, order.entreprise_id, order.projet_id, qr ?? `P-${a.articleId}`, a.libelle, a.categorieId ?? null, order.id, ctx.user.id],
      );
      if (a.photos.length) await this.registerPhotos(tx, ctx, a.photos.map((x) => x.photoId), { articleId: a.articleId, contexte: 'ENLEVEMENT' });
      await tx.query('INSERT INTO ligne_commande (id, tenant_id, commande_id, article_id, statut_ligne) VALUES ($1,$2,$3,$4,$5)', [
        uuidv7(), ctx.user.tenantId, order.id, a.articleId, 'LIVREE',
      ]);
    }
    const year = ctx.at.getUTCFullYear();
    const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [ctx.user.tenantId, 'BL', year])).rows[0]!.n;
    const numero = formatDocumentNumber('BL', year, seq);
    await tx.query(
      `INSERT INTO bon_de_livraison (id, tenant_id, numero, mission_id, commande_id, entreprise_id, type, contenu, signataire_nom, signataire_qualite,
                                     signature_svg, signe_le, latitude, longitude, precision_m, appareil_id, empreinte_sha256, statut)
       VALUES ($1,$2,$3,$4,$5,$6,'ENLEVEMENT',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'SIGNE')`,
      [
        p.blId, ctx.user.tenantId, numero, mission.id, order.id, order.entreprise_id, JSON.stringify(pickupContent(p)),
        p.signataire.nom, p.signataire.qualite, p.signatureSvg, p.signedAt, p.gps?.lat ?? null, p.gps?.lng ?? null,
        p.gps?.precision ?? null, ctx.deviceId, expected,
      ],
    );
    await this.orders.setStatus(tx, ctx.user, order, 'COLLECTEE');
    await this.finishMission(tx, ctx, mission);
    return { blId: p.blId, numero, empreinte: expected, nbArticles: p.articles.length };
  }

  // =====================================================================================
  // Photos
  // =====================================================================================

  /** Enregistre le binaire d'une photo déclarée par une action (envoyé après les données, §7.5). */
  async photoUploaded(user: AuthUser, photoId: string, key: string, mime: string, size: number) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `UPDATE photo SET televersee = true, cle_originale = $2, type_mime = $3, taille_octets = $4 WHERE id = $1 RETURNING id`,
        [photoId, key, mime, size],
      );
      if (!r.rowCount) throw notFound('Photo (envoyez d’abord l’action qui la déclare)');
      // REC-05 : les copies d'un article dupliqué partagent ce fichier
      await tx.query(`UPDATE photo SET televersee = true, cle_originale = $2, type_mime = $3, taille_octets = $4 WHERE copie_de = $1`, [photoId, key, mime, size]);
      return { photoId, televersee: true };
    });
  }

  // =====================================================================================
  // Outils internes
  // =====================================================================================

  /**
   * Applique un mouvement : journal + projection dans la même transaction.
   * Si un mouvement plus récent (horodatage terminal) a déjà été appliqué, celui-ci est seulement
   * journalisé et une alerte de réconciliation est créée (§7.5, « le plus récent l'emporte »).
   */
  private async move(
    tx: Tx,
    ctx: ActionCtx,
    article: ArticleRow,
    mv: { type: MovementType; toLocationId?: string | null; targetStatus?: ArticleStatus; missionId?: string; umId?: string; motif?: string },
  ): Promise<{ applied: boolean }> {
    const stale = !!article.dernier_mouvement_terminal && article.dernier_mouvement_terminal > ctx.at && (mv.type === 'TRANSFERT' || mv.type === 'RANGEMENT');
    const next = applyMovement(
      { status: article.statut, locationId: article.emplacement_courant_id, unitId: article.um_courante_id },
      { type: mv.type, toLocationId: mv.toLocationId, targetStatus: mv.targetStatus },
    );
    await tx.query(
      `INSERT INTO mouvement (id, tenant_id, article_id, um_id, type, de_emplacement_id, vers_emplacement_id, statut_avant, statut_apres,
                              mission_id, auteur_id, appareil_id, horodatage_terminal, motif, applique)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        uuidv7(), ctx.user.tenantId, article.id, mv.umId ?? null, mv.type, article.emplacement_courant_id, next.locationId,
        article.statut, next.status, mv.missionId ?? null, ctx.user.id, ctx.deviceId, ctx.at, mv.motif ?? null, !stale,
      ],
    );
    if (stale) {
      ctx.warnings.push('Mouvement plus ancien que la position connue : journalisé, à réconcilier');
      await this.alert(tx, ctx.user, 'RECONCILIATION', {
        articleId: article.id,
        details: { mouvement: mv.type, vers: mv.toLocationId ?? null, horodatage: ctx.at.toISOString() },
      });
      return { applied: false };
    }
    await tx.query(
      `UPDATE article SET statut = $2, emplacement_courant_id = $3, um_courante_id = $4, dernier_mouvement_le = now(),
              dernier_mouvement_terminal = $5, date_entree = CASE WHEN $6 THEN coalesce(date_entree, now()) ELSE date_entree END
        WHERE id = $1`,
      [article.id, next.status, next.locationId, next.unitId, ctx.at, next.status === 'EN_STOCK'],
    );
    Object.assign(article, { statut: next.status, emplacement_courant_id: next.locationId, um_courante_id: next.unitId, dernier_mouvement_terminal: ctx.at });
    return { applied: true };
  }

  private qr(input: string, expected: 'A' | 'U' | 'E'): string {
    const parsed = parseQr(input);
    if (!parsed || parsed.type !== expected) {
      const what = { A: 'article', U: 'unité de manutention', E: 'emplacement' }[expected];
      throw unprocessable('QR_INVALIDE', `Ce QR n'est pas un QR ${what}`);
    }
    return parsed.qr;
  }

  /** O1 : un QR vierge pré-imprimé n'est attribuable qu'une fois. */
  private async claimBlankQr(tx: Tx, user: AuthUser, qr: string) {
    const r = await tx.query<{ attribue_le: Date | null }>('SELECT attribue_le FROM qr_vierge WHERE tenant_id = $1 AND qr_code = $2 FOR UPDATE', [user.tenantId, qr]);
    if (!r.rows[0]) throw unprocessable('QR_INCONNU', "Ce QR ne provient pas d'une planche JAMYSTOCK");
    if (r.rows[0].attribue_le) throw conflict('QR_DEJA_UTILISE', 'QR déjà utilisé');
    await tx.query('UPDATE qr_vierge SET attribue_le = now() WHERE tenant_id = $1 AND qr_code = $2', [user.tenantId, qr]);
  }

  private async articleByQr(tx: Tx, input: string): Promise<ArticleRow> {
    const qr = this.qr(input, 'A');
    const r = await tx.query<ArticleRow>('SELECT * FROM article WHERE qr_code = $1 FOR UPDATE', [qr]);
    if (!r.rows[0]) throw notFound('Article');
    return r.rows[0];
  }

  private async locationByQr(tx: Tx, input: string): Promise<LocationRow> {
    const qr = this.qr(input, 'E');
    const r = await tx.query<LocationRow>(
      `SELECT e.id, e.code, e.chemin, e.statut, e.type, e.surface_m2, e.charge_max_kg, e.adressable, z.type AS zone_type
         FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE e.qr_code = $1`,
      [qr],
    );
    if (!r.rows[0]) throw notFound('Emplacement');
    return r.rows[0];
  }

  private async umByQr(tx: Tx, input: string): Promise<UmRow> {
    const qr = this.qr(input, 'U');
    const r = await tx.query<UmRow>('SELECT * FROM unite_manutention WHERE qr_code = $1 FOR UPDATE', [qr]);
    if (!r.rows[0]) throw notFound('Unité de manutention');
    return r.rows[0];
  }

  private assertStorageZone(loc: LocationRow) {
    if (loc.zone_type !== 'STOCKAGE' && loc.zone_type !== 'QUARANTAINE') {
      throw unprocessable('ZONE_NON_STOCKAGE', `Rangement impossible en zone ${loc.zone_type.toLowerCase()}`);
    }
  }

  /** §4.1 étape 8 : capacité (surface et charge). Alerte non bloquante : l'opérateur peut forcer avec motif. */
  private async checkCapacity(tx: Tx, ctx: ActionCtx, loc: LocationRow, addM2: number, addKg: number, force?: boolean, motif?: string, articleId?: string) {
    if (loc.surface_m2 <= 0) return;
    const r = await tx.query<{ m2: number; kg: number }>(
      `SELECT coalesce(sum(m2), 0)::float AS m2, coalesce(sum(kg), 0)::float AS kg FROM (
         SELECT coalesce(a.longueur_m * a.largeur_m, 0) * CASE WHEN a.empilable THEN 0.5 ELSE 1 END AS m2, coalesce(a.poids_kg, 0) AS kg
           FROM article a WHERE a.emplacement_courant_id = $1 AND a.um_courante_id IS NULL AND a.statut IN ('EN_STOCK','RESERVE')
             AND a.id IS DISTINCT FROM $2
         UNION ALL
         SELECT u.longueur_m * u.largeur_m, 0 FROM unite_manutention u WHERE u.emplacement_courant_id = $1 AND u.actif
       ) t`,
      [loc.id, articleId ?? null],
    );
    const used = r.rows[0]!;
    const problems: string[] = [];
    if (used.m2 + addM2 > loc.surface_m2 * 1.0001) problems.push(`surface (${(used.m2 + addM2).toFixed(2)} / ${loc.surface_m2} m²)`);
    if (loc.charge_max_kg && used.kg + addKg > loc.charge_max_kg) problems.push(`charge (${used.kg + addKg} / ${loc.charge_max_kg} kg)`);
    if (!problems.length) return;
    if (!force || !motif?.trim()) {
      throw new BusinessError(409, 'CAPACITE_DEPASSEE', `Capacité dépassée : ${problems.join(', ')}. Forcer avec un motif ?`);
    }
    ctx.warnings.push(`Capacité forcée : ${problems.join(', ')}`);
    await this.alert(tx, ctx.user, 'CAPACITE_FORCEE', { articleId, details: { emplacement: loc.code, problems, motif } });
  }

  private async receptionDock(tx: Tx): Promise<string | null> {
    const r = await tx.query<{ id: string }>(
      `SELECT e.id FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.type = 'RECEPTION' AND e.statut = 'ACTIF' ORDER BY e.code LIMIT 1`,
    );
    return r.rows[0]?.id ?? null;
  }

  private async resolveOwner(tx: Tx, entrepriseId: string | undefined, projetId: string | null, commandeId: string | null) {
    if (commandeId) {
      const c = (await tx.query<{ entreprise_id: string; projet_id: string | null; type: string }>('SELECT entreprise_id, projet_id, type FROM commande WHERE id = $1', [commandeId])).rows[0];
      if (!c || c.type !== 'COLLECTE') throw notFound('Collecte');
      return { entrepriseId: c.entreprise_id, projetId: projetId ?? c.projet_id };
    }
    if (!entrepriseId) throw unprocessable('CLIENT_REQUIS', 'Client ou collecte de rattachement obligatoire');
    if (projetId) {
      const p = (await tx.query<{ entreprise_id: string }>('SELECT entreprise_id FROM projet WHERE id = $1', [projetId])).rows[0];
      if (!p || p.entreprise_id !== entrepriseId) throw unprocessable('PROJET_INVALIDE', 'Projet inconnu pour ce client');
    }
    return { entrepriseId, projetId };
  }

  private async isProvisional(tx: Tx, articleId: string): Promise<boolean> {
    const r = await tx.query<{ qr_code: string; statut: string }>('SELECT qr_code, statut FROM article WHERE id = $1', [articleId]);
    return !!r.rows[0] && r.rows[0].statut === 'ATTENDU' && r.rows[0].qr_code.startsWith('P-');
  }

  private async categoryDefaults(tx: Tx, categorieId: string | null) {
    const none = { longueur_m: null, largeur_m: null, hauteur_m: null, empilable: false };
    if (!categorieId) return none;
    const r = await tx.query<typeof none>('SELECT longueur_m, largeur_m, hauteur_m, empilable FROM categorie WHERE id = $1', [categorieId]);
    return r.rows[0] ?? none;
  }

  private async registerPhotos(tx: Tx, ctx: ActionCtx, photoIds: string[], ref: { articleId: string; contexte: string; blId?: string }) {
    const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM photo WHERE article_id = $1', [ref.articleId])).rows[0]!.n;
    if (ref.contexte === 'RECEPTION' && count + photoIds.length > MAX_PHOTOS_PER_ARTICLE + 2) {
      throw unprocessable('PHOTOS', 'Trop de photos pour cet article');
    }
    for (const id of photoIds) {
      await tx.query(
        `INSERT INTO photo (id, tenant_id, article_id, bl_id, cle_originale, contexte, prise_le, prise_par)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [id, ctx.user.tenantId, ref.articleId, ref.blId ?? null, `${ctx.user.tenantId}/photos/${id}`, ref.contexte, ctx.at, ctx.user.id],
      );
    }
  }

  /** INV-07 : bien à photographier, avec la demande du client. */
  private async photoRequestInfo(tx: Tx, user: AuthUser, mission: MissionRow) {
    const d = mission.donnees as { articleId?: string; demande?: string; message?: string };
    const a = (
      await tx.query<{ id: string; qr_code: string; libelle: string; nom_client: string | null; etat: string; chemin: string | null; client: string; photo: string | null }>(
        `SELECT a.id, a.qr_code, a.libelle, a.nom_client, a.etat, e.chemin, ent.nom AS client,
                (SELECT p.id FROM photo p WHERE p.article_id = a.id AND p.televersee ORDER BY p.prise_le LIMIT 1) AS photo
           FROM article a JOIN entreprise ent ON ent.id = a.entreprise_id LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id WHERE a.id = $1`,
        [d.articleId],
      )
    ).rows[0];
    if (!a) return null;
    return {
      type: d.demande ?? 'PHOTO',
      message: d.message ?? null,
      article: { id: a.id, qrCode: a.qr_code, libelle: a.libelle, nomClient: a.nom_client, etat: a.etat, chemin: a.chemin, client: a.client, vignette: a.photo ? this.files.photoUrl(user.tenantId, a.photo, 't') : null },
    };
  }

  /**
   * INV-07 : l'opérateur scanne le bien demandé, le photographie et note son état. La mission se termine, la prestation
   * « Photo à la demande » est pointée selon la grille du client (0 € si elle n'y figure pas) et le client est prévenu.
   */
  private async photoRequestDone(tx: Tx, ctx: ActionCtx, p: { missionId: string; articleQr: string; photoIds: string[]; etat?: string; commentaire?: string }) {
    const mission = await this.mission(tx, ctx.user, p.missionId, true, ['PHOTO']);
    const article = await this.articleByQr(tx, p.articleQr);
    const d = mission.donnees as { articleId?: string; entrepriseId?: string; demande?: string; demandeurId?: string };
    if (d.articleId !== article.id) throw conflict('MAUVAIS_ARTICLE', `« ${article.libelle} » n’est pas le bien demandé`);
    if (p.photoIds.length < 1 || p.photoIds.length > MAX_PHOTOS_PER_ARTICLE) throw unprocessable('PHOTOS', `Entre 1 et ${MAX_PHOTOS_PER_ARTICLE} photos`);
    await this.registerPhotos(tx, ctx, p.photoIds, { articleId: article.id, contexte: d.demande === 'CONSTAT' ? 'CONSTAT' : 'A_LA_DEMANDE' });
    const etatAvant = (await tx.query<{ etat: string }>('SELECT etat FROM article WHERE id = $1', [article.id])).rows[0]!.etat;
    if (p.etat && p.etat !== etatAvant) {
      await tx.query('UPDATE article SET etat = $2, updated_at = now() WHERE id = $1', [article.id, p.etat]);
      await this.audit.record(tx, ctx.user, { action: 'ETAT_CONSTATE', objet: 'article', objetId: article.id, entrepriseId: d.entrepriseId ?? null, avant: { etat: etatAvant }, apres: { etat: p.etat }, motif: p.commentaire ?? null });
    }
    await this.startMission(tx, ctx, mission, { commentaire: p.commentaire ?? null, photoIds: p.photoIds, etatConstate: p.etat ?? etatAvant });
    await this.finishMission(tx, ctx, mission);
    if (d.entrepriseId) {
      await tx.query(
        `INSERT INTO prestation_a_facturer (id, tenant_id, entreprise_id, code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, source_id, date_prestation)
         SELECT $1, $2, $3, 'PHOTO_DEMANDE', coalesce(l->>'libelle', 'Photo à la demande'), 1, 'forfait',
                coalesce((l->>'prix_ht_cents')::int, 0), coalesce((l->>'tva')::numeric, 20), $4, $5::date
           FROM (SELECT 1) one
           LEFT JOIN LATERAL (
             SELECT l FROM forfait f JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id, jsonb_array_elements(g.lignes) l
              WHERE f.entreprise_id = $3 AND f.statut = 'ACTIF' AND l->>'code' = 'PHOTO_DEMANDE' LIMIT 1
           ) t ON true`,
        [uuidv7(), ctx.user.tenantId, d.entrepriseId, mission.id, ctx.at.toISOString().slice(0, 10)],
      );
    }
    if (d.demandeurId) {
      const vars = { articleId: article.id, libelle: article.libelle, demande: d.demande ?? 'PHOTO', commentaire: p.commentaire ?? null };
      await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,$3,'IN_APP','PHOTO_PRETE',$4)`, [
        uuidv7(), ctx.user.tenantId, d.demandeurId, JSON.stringify(vars),
      ]);
      await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,$3,'EMAIL','PHOTO_PRETE',$4)`, [
        uuidv7(), ctx.user.tenantId, d.demandeurId, JSON.stringify(vars),
      ]);
    }
    return { articleId: article.id, missionId: mission.id, photos: p.photoIds.length };
  }

  private async peekMissionType(tx: Tx, missionId: string): Promise<string | null> {
    const r = await tx.query<{ type: string }>('SELECT type FROM mission WHERE id = $1', [missionId]);
    return r.rows[0]?.type ?? null;
  }

  /** Portée P (§2.2) : un opérateur ou un chauffeur n'agit que sur les missions qui lui sont affectées. */
  private async mission(tx: Tx, user: AuthUser, missionId: string, forUpdate: boolean, types?: string[], altPermission?: Permission): Promise<MissionRow> {
    const r = await tx.query<MissionRow>(`SELECT * FROM mission WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [missionId]);
    const m = r.rows[0];
    if (!m) throw notFound('Mission');
    if (types && !types.includes(m.type)) throw unprocessable('TYPE_MISSION', `Action impossible sur une mission ${m.type}`);
    const privileged = user.role === 'SUPER_ADMIN' || user.role === 'DISPATCHER';
    if (!privileged && m.assigne_a !== user.id && !(altPermission && can(user.role, altPermission) && !m.assigne_a)) {
      throw forbidden("Cette mission ne vous est pas affectée");
    }
    if (m.statut === 'ANNULEE') throw conflict('MISSION_ANNULEE', 'Mission annulée');
    if (m.statut === 'TERMINEE' && forUpdate) throw conflict('MISSION_TERMINEE', 'Mission déjà terminée');
    return m;
  }

  private async startMission(tx: Tx, ctx: ActionCtx, m: MissionRow, extra: Record<string, unknown> = {}) {
    await tx.query(
      `UPDATE mission SET statut = 'EN_COURS', debut_reel = coalesce(debut_reel, $2), donnees = donnees || $3::jsonb WHERE id = $1`,
      [m.id, ctx.at, JSON.stringify(extra)],
    );
  }

  private async finishMission(tx: Tx, ctx: ActionCtx, m: MissionRow) {
    await tx.query(`UPDATE mission SET statut = 'TERMINEE', debut_reel = coalesce(debut_reel, $2), fin_reelle = $2 WHERE id = $1`, [m.id, ctx.at]);
  }

  private async progress(tx: Tx, orderId: string, done: string[]) {
    const r = await tx.query<{ faits: number; total: number }>(
      `SELECT count(*) FILTER (WHERE statut_ligne = ANY($2))::int AS faits, count(*) FILTER (WHERE statut_ligne <> 'MANQUANTE')::int AS total
         FROM ligne_commande WHERE commande_id = $1`,
      [orderId, done],
    );
    return r.rows[0]!;
  }

  /** §4.3 étape 10 : prestation de livraison pointée (le quota inclus au forfait est appliqué à la facturation). */
  private async recordDeliveryService(tx: Tx, ctx: ActionCtx, order: OrderRow, missionId: string) {
    await tx.query(
      `INSERT INTO prestation_a_facturer (id, tenant_id, entreprise_id, code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, source_id, date_prestation)
       SELECT $1, $2, $3, coalesce(l->>'code', 'LIVRAISON'), coalesce(l->>'libelle', 'Livraison'), 1, 'livraison',
              coalesce((l->>'prix_ht_cents')::int, 0), coalesce((l->>'tva')::numeric, 20), $4, $5::date
         FROM (SELECT 1) one
         LEFT JOIN LATERAL (
           SELECT l FROM forfait f JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id, jsonb_array_elements(g.lignes) l
            WHERE f.entreprise_id = $3 AND f.statut = 'ACTIF' AND l->>'code' LIKE 'LIVRAISON%' ORDER BY l->>'code' LIMIT 1
         ) t ON true`,
      [uuidv7(), ctx.user.tenantId, order.entreprise_id, missionId, ctx.at.toISOString().slice(0, 10)],
    );
  }

  private async alert(tx: Tx, user: AuthUser, type: string, p: { articleId?: string; missionId?: string; details?: Record<string, unknown> }) {
    await tx.query(
      'INSERT INTO alerte_terrain (id, tenant_id, type, article_id, mission_id, details, auteur_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv7(), user.tenantId, type, p.articleId ?? null, p.missionId ?? null, JSON.stringify(p.details ?? {}), user.id],
    );
  }

  private async notifyClient(tx: Tx, user: AuthUser, order: OrderRow, modele: string, vars: Record<string, unknown>) {
    await tx.query(
      `INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,$3,'EMAIL',$4,$5)`,
      [uuidv7(), user.tenantId, order.demandeur_id, modele, JSON.stringify({ commandeId: order.id, numero: order.numero, ...vars })],
    );
  }

  private async notifyStaff(tx: Tx, user: AuthUser, role: string, modele: string, vars: Record<string, unknown>) {
    await tx.query(
      `INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables)
       SELECT gen_random_uuid(), $1, u.id, 'IN_APP', $3, $4 FROM utilisateur u WHERE u.tenant_id = $1 AND u.role = $2 AND u.statut = 'ACTIF'`,
      [user.tenantId, role, modele, JSON.stringify(vars)],
    );
  }
}

function footprint(a: { longueur_m: number | null; largeur_m: number | null; empilable: boolean }): number {
  return (a.longueur_m ?? 0) * (a.largeur_m ?? 0) * (a.empilable ? 0.5 : 1);
}

/** Erreurs déterministes (mémorisables) : règles métier et contraintes de base. */
function toBusiness(err: unknown): { code: string; message: string } | null {
  if (err instanceof BusinessError) return { code: err.code, message: err.message };
  const e = err as { name?: string; code?: string; message?: string; constraint?: string };
  if (e?.name === 'InvalidTransitionError') return { code: 'INVALID_TRANSITION', message: e.message! };
  if (e?.name === 'MovementRuleError') return { code: 'MOVEMENT_RULE', message: e.message! };
  if (e?.code === '23505') return { code: 'UNIQUE_VIOLATION', message: `Conflit d'unicité (${e.constraint ?? 'contrainte'})` };
  if (e?.code === '23503') return { code: 'REFERENCE_INVALIDE', message: 'Référence inconnue' };
  if (e?.code === '22P02') return { code: 'IDENTIFIANT_INVALIDE', message: 'Identifiant invalide' };
  return null;
}

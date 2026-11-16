import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  earliestDeliveryDate,
  formatDocumentNumber,
  isClientEditable,
  isClientRole,
  isLateCancellation,
  suggestVehicle,
  uuidv7,
  volumeM3,
  type OrderStatus,
  type OrderType,
} from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';

export interface OrderRow {
  id: string;
  tenant_id: string;
  numero: string | null;
  entreprise_id: string;
  projet_id: string | null;
  depot_id: string | null;
  demandeur_id: string;
  type: OrderType;
  statut: OrderStatus;
  date_souhaitee: string | null;
  date_confirmee: string | null;
  creneau_confirme: string | null;
  historique_statuts: { statut: OrderStatus; le: string; par: string }[];
}

export interface SubmitInput {
  type: 'LIVRAISON' | 'RETRAIT';
  adresse?: Record<string, unknown>;
  contraintesAcces?: Record<string, unknown>;
  contactSite?: { nom: string; telephone: string };
  dateSouhaitee: string;
  creneau?: string;
}

export interface CollectionInput {
  projetId?: string;
  adresse: Record<string, unknown>;
  contraintesAcces?: Record<string, unknown>;
  contactSite?: { nom: string; telephone: string };
  dateSouhaitee: string;
  creneau?: string;
  description: string;
  volumeEstimeM3?: number;
  lignes?: { description: string; quantite?: number }[];
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- lecture

  async list(user: AuthUser, filter: { statut?: OrderStatus; type?: OrderType }) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT c.id, c.numero, c.type, c.statut, c.projet_id AS "projetId", c.entreprise_id AS "entrepriseId",
                c.date_souhaitee AS "dateSouhaitee", c.date_confirmee AS "dateConfirmee", c.created_at AS "creeLe",
                (SELECT count(*)::int FROM ligne_commande l WHERE l.commande_id = c.id) AS "nbArticles"
           FROM commande c
          WHERE c.statut <> 'BROUILLON' AND ($1::statut_commande IS NULL OR c.statut = $1) AND ($2::type_commande IS NULL OR c.type = $2)
          ORDER BY c.created_at DESC LIMIT 200`,
        [filter.statut ?? null, filter.type ?? null],
      );
      return r.rows;
    });
  }

  async get(user: AuthUser, id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, id);
      return this.present(tx, order);
    });
  }

  // ---------------------------------------------------------------- panier (CMD-01)

  async getCart(user: AuthUser, projetId?: string, now = new Date()) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const cart = await this.findCart(tx, user, projetId);
      const base = cart ? await this.present(tx, cart) : { lignes: [], nbArticles: 0, volumeM3: 0, vehiculeSuggere: null };
      return { ...base, estimation: await this.estimate(tx, user, now) };
    });
  }

  /**
   * CMD-04 : ce que le client voit avant de valider. Date au plus tôt (RG-CMD-01) et coût de la prestation
   * selon sa grille, en signalant les livraisons incluses dans son forfait (RG-M2-06).
   */
  private async estimate(tx: Tx, user: AuthUser, now: Date) {
    const f = (
      await tx.query<{ lignes: { code: string; libelle: string; prix_ht_cents: number }[]; prestations_incluses: Record<string, number> }>(
        `SELECT g.lignes, f.prestations_incluses FROM forfait f JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id
          WHERE f.entreprise_id = $1 AND f.statut = 'ACTIF' AND f.date_debut <= current_date AND (f.date_fin IS NULL OR f.date_fin >= current_date)
          ORDER BY f.version DESC LIMIT 1`,
        [user.entrepriseId],
      )
    ).rows[0];
    const livraison = f?.lignes.find((l) => l.code.startsWith('LIVRAISON'));
    const used = (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM commande WHERE entreprise_id = $1 AND type = 'LIVRAISON'
            AND statut NOT IN ('BROUILLON','ANNULEE','REFUSEE') AND date_trunc('month', created_at) = date_trunc('month', now())`,
        [user.entrepriseId],
      )
    ).rows[0]!.n;
    const incluses = f?.prestations_incluses?.LIVRAISON ?? 0;
    return {
      datePlusTot: earliestDeliveryDate(now),
      livraison: livraison ? { libelle: livraison.libelle, prixHtCents: livraison.prix_ht_cents } : null,
      livraisonsIncluses: incluses,
      livraisonsIncluseRestantes: Math.max(0, incluses - used),
      retraitHtCents: 0,
    };
  }

  async addToCart(user: AuthUser, articleIds: string[], projetId?: string) {
    this.assertClient(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      if (user.role === 'B2B_USER') {
        if (!projetId) throw unprocessable('PROJET_REQUIS', 'Un utilisateur B2B commande projet par projet');
        await this.assertProjectAccess(tx, user, projetId, false);
      }
      const arts = await tx.query<{ id: string; statut: string; projet_id: string | null; engage: boolean }>(
        `SELECT a.id, a.statut, a.projet_id,
                EXISTS (SELECT 1 FROM ligne_commande l WHERE l.article_id = a.id AND l.active) AS engage
           FROM article a WHERE a.id = ANY($1::uuid[])`,
        [articleIds],
      );
      // la RLS masque les articles hors périmètre : ils sont simplement « introuvables »
      if (arts.rows.length !== new Set(articleIds).size) throw notFound('Article');
      for (const a of arts.rows) {
        if (a.statut !== 'EN_STOCK') throw conflict('ARTICLE_INDISPONIBLE', `L'article ${a.id} n'est pas en stock`);
        if (a.engage) throw conflict('ARTICLE_ENGAGE', `L'article ${a.id} est déjà engagé dans une commande en cours`);
        if (projetId && a.projet_id !== projetId) throw unprocessable('PROJET_DIFFERENT', `L'article ${a.id} n'appartient pas au projet`);
      }
      let cart = await this.findCart(tx, user, projetId);
      if (!cart) {
        const id = uuidv7();
        await tx.query(
          `INSERT INTO commande (id, tenant_id, entreprise_id, projet_id, demandeur_id, type, statut, created_by, historique_statuts)
           VALUES ($1, $2, $3, $4, $5, 'LIVRAISON', 'BROUILLON', $5, jsonb_build_array(jsonb_build_object('statut','BROUILLON','le',now(),'par',$6::text)))`,
          [id, user.tenantId, user.entrepriseId, projetId ?? null, user.id, user.id],
        );
        cart = await this.load(tx, id);
      }
      for (const articleId of articleIds) {
        await tx.query(
          `INSERT INTO ligne_commande (id, tenant_id, commande_id, article_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (commande_id, article_id) WHERE article_id IS NOT NULL DO NOTHING`,
          [uuidv7(), user.tenantId, cart.id, articleId],
        );
      }
      return this.present(tx, cart);
    });
  }

  async removeFromCart(user: AuthUser, articleId: string, projetId?: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const cart = await this.findCart(tx, user, projetId);
      if (!cart) throw notFound('Panier');
      await tx.query('DELETE FROM ligne_commande WHERE commande_id = $1 AND article_id = $2', [cart.id, articleId]);
      return this.present(tx, cart);
    });
  }

  // ---------------------------------------------------------------- soumission (CMD-02 à CMD-05, §4.2)

  async submit(user: AuthUser, orderId: string, input: SubmitInput, now = new Date()) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      if (order.demandeur_id !== user.id) throw forbidden('Seul le demandeur peut soumettre son panier');
      if (order.statut !== 'BROUILLON') throw conflict('DEJA_SOUMISE', 'Commande déjà soumise');
      if (input.type === 'LIVRAISON' && (!input.adresse || !input.contactSite)) {
        throw unprocessable('ADRESSE_REQUISE', 'Adresse et contact sur place obligatoires pour une livraison');
      }

      const lines = await tx.query<{ article_id: string; libelle: string; statut: string; longueur_m: number | null; largeur_m: number | null; hauteur_m: number | null; poids_kg: number | null; depot_id: string | null }>(
        `SELECT a.id AS article_id, a.libelle, a.statut, a.longueur_m, a.largeur_m, a.hauteur_m, a.poids_kg, z.depot_id
           FROM ligne_commande l JOIN article a ON a.id = l.article_id
           LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id LEFT JOIN zone z ON z.id = e.zone_id
          WHERE l.commande_id = $1 FOR UPDATE OF a`,
        [order.id],
      );
      if (lines.rows.length === 0) throw unprocessable('PANIER_VIDE', 'Le panier est vide');
      const unavailable = lines.rows.filter((l) => l.statut !== 'EN_STOCK');
      if (unavailable.length) throw conflict(
          'ARTICLE_INDISPONIBLE',
          `Plus disponible${unavailable.length > 1 ? 's' : ''} (déjà dans une autre commande) : ${unavailable.map((l) => l.libelle).join(', ')}. Retirez-${unavailable.length > 1 ? 'les' : 'le'} du panier.`,
        );
      const depots = new Set(lines.rows.map((l) => l.depot_id).filter(Boolean));
      if (depots.size > 1) throw unprocessable('MULTI_DEPOTS', 'Les articles d’une commande doivent être dans le même dépôt');
      const depotId = [...depots][0] ?? null;

      // RG-CMD-01 : délai minimum (paramètre par dépôt)
      const delay = depotId
        ? (await tx.query<{ d: number }>('SELECT delai_min_heures_ouvrees AS d FROM depot WHERE id = $1', [depotId])).rows[0]?.d ?? 48
        : 48;
      const earliest = earliestDeliveryDate(now, delay);
      if (input.dateSouhaitee < earliest) {
        throw unprocessable('DELAI_MINIMUM', `Date trop proche : première date possible le ${earliest}`);
      }

      // CMD-04 : volume et véhicule
      const vol = volumeM3(lines.rows.map((l) => ({ lengthM: l.longueur_m ?? 0, widthM: l.largeur_m ?? 0, heightM: l.hauteur_m ?? 0 })));
      const weight = lines.rows.reduce((s, l) => s + (l.poids_kg ?? 0), 0);
      const vehicle = input.type === 'LIVRAISON' ? suggestVehicle(vol, weight) : null;

      // CMD-05 : validation interne si l'utilisateur ne peut pas commander seul ou dépasse son plafond
      const needsApproval = await this.needsApproval(tx, user, order.projet_id, lines.rows.length);
      const next: OrderStatus = needsApproval ? 'EN_ATTENTE_VALIDATION' : 'SOUMISE';
      assertTransition(order.type, order.statut, next);

      const year = now.getUTCFullYear();
      const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [user.tenantId, 'CMD', year])).rows[0]!.n;

      await tx.query(
        `UPDATE commande SET type = $2, adresse = $3, contraintes_acces = $4, contact_site = $5, date_souhaitee = $6,
                creneau_souhaite = $7, depot_id = $8, volume_m3 = $9, poids_kg = $10, vehicule_suggere = $11, numero = $12
          WHERE id = $1`,
        [
          order.id,
          input.type,
          input.adresse ? JSON.stringify(input.adresse) : null,
          JSON.stringify(input.contraintesAcces ?? {}),
          input.contactSite ? JSON.stringify(input.contactSite) : null,
          input.dateSouhaitee,
          input.creneau ?? null,
          depotId,
          vol,
          weight || null,
          vehicle?.code ?? null,
          formatDocumentNumber('CMD', year, seq),
        ],
      );
      // le changement de statut active les lignes ; l'index unique partiel garantit
      // qu'un article n'est que dans une seule commande active (verrou optimiste §4.2)
      try {
        await this.setStatus(tx, user, { ...order, type: input.type }, next);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw conflict('ARTICLE_ENGAGE', 'Un des articles vient d’être engagé dans une autre commande');
        }
        throw err;
      }
      await tx.query(`UPDATE article SET statut = 'RESERVE' WHERE id = ANY($1::uuid[])`, [lines.rows.map((l) => l.article_id)]);
      await this.notify(tx, user, order, needsApproval ? 'VALIDATION_REQUISE' : 'COMMANDE_SOUMISE');
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  /** CMD-06 : demande de collecte (mise en stock). */
  async requestCollection(user: AuthUser, input: CollectionInput, now = new Date()) {
    this.assertClient(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      if (user.role === 'B2B_USER') {
        if (!input.projetId) throw unprocessable('PROJET_REQUIS', 'Projet de rattachement obligatoire');
        await this.assertProjectAccess(tx, user, input.projetId, false);
      }
      const earliest = earliestDeliveryDate(now);
      if (input.dateSouhaitee < earliest) throw unprocessable('DELAI_MINIMUM', `Date trop proche : première date possible le ${earliest}`);
      const id = uuidv7();
      const year = now.getUTCFullYear();
      const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [user.tenantId, 'CMD', year])).rows[0]!.n;
      await tx.query(
        `INSERT INTO commande (id, tenant_id, numero, entreprise_id, projet_id, demandeur_id, type, statut, adresse, contraintes_acces,
                               contact_site, date_souhaitee, creneau_souhaite, description_collecte, volume_m3, created_by, historique_statuts)
         VALUES ($1,$2,$3,$4,$5,$6,'COLLECTE','BROUILLON',$7,$8,$9,$10,$11,$12,$13,$6,
                 jsonb_build_array(jsonb_build_object('statut','BROUILLON','le',now(),'par',$14::text)))`,
        [
          id, user.tenantId, formatDocumentNumber('CMD', year, seq), user.entrepriseId, input.projetId ?? null, user.id,
          JSON.stringify(input.adresse), JSON.stringify(input.contraintesAcces ?? {}),
          input.contactSite ? JSON.stringify(input.contactSite) : null, input.dateSouhaitee, input.creneau ?? null,
          input.description, input.volumeEstimeM3 ?? null, user.id,
        ],
      );
      for (const l of input.lignes ?? []) {
        await tx.query(
          'INSERT INTO ligne_commande (id, tenant_id, commande_id, description_libre, quantite_estimee) VALUES ($1,$2,$3,$4,$5)',
          [uuidv7(), user.tenantId, id, l.description, l.quantite ?? 1],
        );
      }
      const order = await this.load(tx, id);
      const needsApproval = await this.needsApproval(tx, user, order.projet_id, 0);
      await this.setStatus(tx, user, order, needsApproval ? 'EN_ATTENTE_VALIDATION' : 'SOUMISE');
      await this.notify(tx, user, order, needsApproval ? 'VALIDATION_REQUISE' : 'COMMANDE_SOUMISE');
      return this.present(tx, await this.load(tx, id));
    });
  }

  // ---------------------------------------------------------------- validation interne B2B (CMD-05)

  async approve(user: AuthUser, orderId: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      this.assertCanApprove(user, order);
      await this.setStatus(tx, user, order, 'SOUMISE');
      await tx.query('UPDATE commande SET valideur_id = $2 WHERE id = $1', [order.id, user.id]);
      await this.notify(tx, user, order, 'VALIDATION_ACCORDEE');
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  async reject(user: AuthUser, orderId: string, motif: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      this.assertCanApprove(user, order);
      await this.setStatus(tx, user, order, 'REFUSEE', motif);
      await tx.query('UPDATE commande SET valideur_id = $2, motif_refus = $3 WHERE id = $1', [order.id, user.id, motif]);
      await this.releaseArticles(tx, order.id);
      await this.notify(tx, user, order, 'VALIDATION_REFUSEE');
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  // ---------------------------------------------------------------- annulation (CMD-07, RG-CMD-03)

  async cancel(user: AuthUser, orderId: string, motif?: string, now = new Date()) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      if (isClientRole(user.role) && order.statut !== 'PLANIFIEE' && !isClientEditable(order.statut)) {
        throw conflict('NON_ANNULABLE', 'Commande en préparation : contactez l’exploitant');
      }
      if (user.role === 'B2B_USER' && order.demandeur_id !== user.id) throw forbidden();
      if (order.statut === 'BROUILLON' || order.statut === 'EN_ATTENTE_VALIDATION') {
        // un panier ou une demande non validée est simplement supprimé(e) / refusé(e)
        if (order.statut === 'BROUILLON') {
          await tx.query('DELETE FROM commande WHERE id = $1', [order.id]);
          return { id: order.id, supprime: true };
        }
        await this.setStatus(tx, user, order, 'REFUSEE', motif ?? 'Annulée par le demandeur');
        await this.releaseArticles(tx, order.id);
        return this.present(tx, await this.load(tx, order.id));
      }
      await this.setStatus(tx, user, order, 'ANNULEE', motif);
      await this.releaseArticles(tx, order.id);
      await tx.query(`UPDATE mission SET statut = 'ANNULEE' WHERE commande_id = $1 AND statut IN ('A_AFFECTER','AFFECTEE')`, [order.id]);
      const date = order.date_confirmee ?? order.date_souhaitee;
      const late = order.statut === 'PLANIFIEE' && !!date && isLateCancellation(new Date(`${date}T08:00:00Z`), now);
      if (late) {
        await tx.query(
          `INSERT INTO prestation_a_facturer (id, tenant_id, entreprise_id, code, libelle, quantite, unite, prix_unitaire_ht_cents, source_id, date_prestation)
           SELECT $1, $2, $3, 'ANNULATION_TARDIVE', 'Annulation tardive (< 24 h)', 1, 'forfait',
                  coalesce((SELECT (l->>'prix_ht_cents')::int FROM forfait f JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id,
                             jsonb_array_elements(g.lignes) l
                            WHERE f.entreprise_id = $3 AND f.statut = 'ACTIF' AND l->>'code' = 'ANNULATION_TARDIVE' LIMIT 1), 0),
                  $4, $5::date`,
          [uuidv7(), user.tenantId, order.entreprise_id, order.id, now.toISOString().slice(0, 10)],
        );
      }
      return { ...(await this.present(tx, await this.load(tx, order.id))), annulationTardive: late };
    });
  }

  // ---------------------------------------------------------------- dispatch (FLX-02, §4.2 étapes 8-9)

  async plan(user: AuthUser, orderId: string, input: { date: string; creneau?: string }) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      await this.setStatus(tx, user, order, 'PLANIFIEE');
      await tx.query('UPDATE commande SET date_confirmee = $2, creneau_confirme = $3, date_contre_proposee = NULL WHERE id = $1', [
        order.id,
        input.date,
        input.creneau ?? null,
      ]);
      await this.createMissions(tx, user, { ...order, date_confirmee: input.date });
      await this.notify(tx, user, order, 'CRENEAU_CONFIRME');
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  async counterPropose(user: AuthUser, orderId: string, input: { date: string; message?: string }) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      if (order.statut !== 'SOUMISE') throw conflict('STATUT', 'Contre-proposition possible uniquement sur une demande reçue');
      await tx.query('UPDATE commande SET date_contre_proposee = $2, message_dispatcher = $3 WHERE id = $1', [order.id, input.date, input.message ?? null]);
      await this.notify(tx, user, order, 'CRENEAU_CONTRE_PROPOSE');
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  /** Le client accepte la date contre-proposée en un clic (FLX-02). */
  async acceptCounterProposal(user: AuthUser, orderId: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const order = await this.load(tx, orderId, true);
      const r = await tx.query<{ d: string | null }>('SELECT date_contre_proposee AS d FROM commande WHERE id = $1', [order.id]);
      const date = r.rows[0]?.d;
      if (!date) throw conflict('PAS_DE_CONTRE_PROPOSITION', 'Aucune date contre-proposée');
      await this.setStatus(tx, user, order, 'PLANIFIEE');
      await tx.query('UPDATE commande SET date_confirmee = $2, date_contre_proposee = NULL WHERE id = $1', [order.id, date]);
      await this.createMissions(tx, user, { ...order, date_confirmee: date });
      return this.present(tx, await this.load(tx, order.id));
    });
  }

  // ---------------------------------------------------------------- transitions génériques

  /** Seul point d'écriture du statut : machine à états + historique (frise SUI-01) + audit. */
  async setStatus(tx: Tx, user: AuthUser, order: OrderRow, to: OrderStatus, motif?: string): Promise<void> {
    assertTransition(order.type, order.statut, to);
    await tx.query(
      `UPDATE commande SET statut = $2,
              historique_statuts = historique_statuts || jsonb_build_array(jsonb_build_object('statut', $4::text, 'le', now(), 'par', $3::text))
        WHERE id = $1`,
      [order.id, to, user.id, to],
    );
    await this.audit.record(tx, user, {
      action: 'COMMANDE_TRANSITION',
      objet: 'commande',
      objetId: order.id,
      entrepriseId: order.entreprise_id,
      avant: { statut: order.statut },
      apres: { statut: to },
      motif,
    });
    order.statut = to;
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<OrderRow> {
    const r = await tx.query<OrderRow>(`SELECT * FROM commande WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw notFound('Commande');
    return r.rows[0];
  }

  // ---------------------------------------------------------------- interne

  private assertClient(user: AuthUser) {
    if (!isClientRole(user.role) || !user.entrepriseId) {
      throw forbidden('Seul un compte client peut créer un panier (le back-office commandera « pour le compte de » en phase D)');
    }
  }

  private assertCanApprove(user: AuthUser, order: OrderRow) {
    if (user.role === 'SUPER_ADMIN') return;
    if (user.role !== 'B2B_ADMIN' || user.entrepriseId !== order.entreprise_id) throw forbidden('Validation réservée au B2B Admin');
  }

  private async assertProjectAccess(tx: Tx, user: AuthUser, projetId: string, mustOrder: boolean) {
    const r = await tx.query<{ peut_commander: boolean }>(
      'SELECT peut_commander FROM acces_projet WHERE utilisateur_id = $1 AND projet_id = $2',
      [user.id, projetId],
    );
    if (!r.rows[0] || (mustOrder && !r.rows[0].peut_commander)) throw forbidden('Projet hors de votre périmètre');
  }

  private async needsApproval(tx: Tx, user: AuthUser, projetId: string | null, nbArticles: number): Promise<boolean> {
    if (user.role !== 'B2B_USER') return false;
    const r = await tx.query<{ peut_commander_seul: boolean; plafond: number | null; ap_peut: boolean | null; ap_plafond: number | null }>(
      `SELECT u.peut_commander_seul, u.plafond_articles_sans_validation AS plafond, ap.peut_commander AS ap_peut,
              ap.plafond_sans_validation AS ap_plafond
         FROM utilisateur u LEFT JOIN acces_projet ap ON ap.utilisateur_id = u.id AND ap.projet_id = $2
        WHERE u.id = $1`,
      [user.id, projetId ?? ZERO_UUID],
    );
    const row = r.rows[0];
    if (!row) return true;
    if (!row.peut_commander_seul || row.ap_peut === false) return true;
    const cap = row.ap_plafond ?? row.plafond;
    return cap !== null && nbArticles > cap;
  }

  private async findCart(tx: Tx, user: AuthUser, projetId?: string): Promise<OrderRow | null> {
    const r = await tx.query<OrderRow>(
      `SELECT * FROM commande WHERE demandeur_id = $1 AND statut = 'BROUILLON' AND type <> 'COLLECTE'
          AND coalesce(projet_id, $2::uuid) = $3::uuid LIMIT 1`,
      [user.id, ZERO_UUID, projetId ?? ZERO_UUID],
    );
    return r.rows[0] ?? null;
  }

  private async releaseArticles(tx: Tx, orderId: string) {
    await tx.query(
      `UPDATE article SET statut = 'EN_STOCK'
        WHERE statut = 'RESERVE' AND id IN (SELECT article_id FROM ligne_commande WHERE commande_id = $1)`,
      [orderId],
    );
  }

  /** §4.2 étape 9 : préparation (la veille par défaut) + transport, ou enlèvement pour une collecte. */
  private async createMissions(tx: Tx, user: AuthUser, order: OrderRow) {
    const existing = await tx.query(`SELECT 1 FROM mission WHERE commande_id = $1 AND statut <> 'ANNULEE'`, [order.id]);
    if (existing.rowCount) return; // replanification après échec : missions conservées
    const day = order.date_confirmee!;
    const insert = (type: string, debut: string) =>
      tx.query(
        `INSERT INTO mission (id, tenant_id, commande_id, depot_id, type, debut_prevu) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [uuidv7(), user.tenantId, order.id, order.depot_id, type, debut],
      );
    if (order.type === 'COLLECTE') {
      await insert('COLLECTE', `${day}T08:00:00Z`);
      return;
    }
    const veille = new Date(`${day}T00:00:00Z`);
    veille.setUTCDate(veille.getUTCDate() - 1);
    await insert('PREPARATION', `${veille.toISOString().slice(0, 10)}T14:00:00Z`);
    await insert(order.type === 'RETRAIT' ? 'RETRAIT' : 'LIVRAISON', `${day}T08:00:00Z`);
  }

  /** Notifications (§6.3) : mises en file ; l'envoi effectif est fait par le worker (phase D). */
  private async notify(tx: Tx, user: AuthUser, order: OrderRow, modele: string) {
    await tx.query(
      `INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables)
       VALUES ($1, $2, $3, 'IN_APP', $4, $5)`,
      [uuidv7(), user.tenantId, order.demandeur_id, modele, JSON.stringify({ commandeId: order.id, numero: order.numero })],
    );
  }

  private async present(tx: Tx, order: OrderRow) {
    const lignes = await tx.query<{ longueur_m: number | null; largeur_m: number | null; hauteur_m: number | null }>(
      `SELECT l.id, l.article_id AS "articleId", l.description_libre AS "descriptionLibre", l.statut_ligne AS "statutLigne",
              a.libelle, a.qr_code AS "qrCode", a.longueur_m, a.largeur_m, a.hauteur_m,
              (a.id IS NULL OR a.statut = 'EN_STOCK' OR c.statut <> 'BROUILLON') AS disponible
         FROM ligne_commande l JOIN commande c ON c.id = l.commande_id LEFT JOIN article a ON a.id = l.article_id
        WHERE l.commande_id = $1 ORDER BY l.id`,
      [order.id],
    );
    const full = await tx.query('SELECT * FROM commande WHERE id = $1', [order.id]);
    const c = full.rows[0] as Record<string, unknown>;
    const vol = volumeM3(lignes.rows.map((l) => ({ lengthM: l.longueur_m ?? 0, widthM: l.largeur_m ?? 0, heightM: l.hauteur_m ?? 0 })));
    return {
      id: c.id,
      numero: c.numero,
      type: c.type,
      statut: c.statut,
      entrepriseId: c.entreprise_id,
      projetId: c.projet_id,
      depotId: c.depot_id,
      dateSouhaitee: c.date_souhaitee,
      dateConfirmee: c.date_confirmee,
      creneauConfirme: c.creneau_confirme,
      dateContreProposee: c.date_contre_proposee,
      motifRefus: c.motif_refus,
      adresse: c.adresse,
      contactSite: c.contact_site,
      historique: c.historique_statuts,
      nbArticles: lignes.rows.length,
      volumeM3: vol,
      vehiculeSuggere: suggestVehicle(vol)?.label ?? null,
      lignes: lignes.rows.map(({ longueur_m: _l, largeur_m: _w, hauteur_m: _h, ...rest }) => rest),
    };
  }
}

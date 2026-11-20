import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ORDER_STATUSES, ORDER_TYPES, isValidFrenchVat, isValidSiret, normalizeSiret, uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import { createInvitation } from '../accounts/invitations.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { liveSurface } from '../client/client.controller.js';
import { FilesService } from '../files/files.service.js';

const uuid = z.string().uuid();
const isoDate = z.string().date();

/** Statuts où la demande attend encore une action du dépôt : le badge « urgent » n'a de sens que là. */
const OPEN = `('EN_ATTENTE_VALIDATION','SOUMISE','PLANIFIEE','EN_PREPARATION','PRETE')`;

const OrdersQuery = z.object({
  statut: z.enum(ORDER_STATUSES).optional(),
  type: z.enum(ORDER_TYPES).optional(),
  client: uuid.optional(),
  depot: uuid.optional(),
  du: isoDate.optional(),
  au: isoDate.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

const Adresse = z.object({ libelle: z.string().min(3), codePostal: z.string().optional(), ville: z.string().optional() });
const ClientBody = z
  .object({
    type: z.enum(['B2B', 'B2C']),
    nom: z.string().trim().min(2).max(200),
    siret: z.string().trim().optional(),
    tvaIntracom: z.string().trim().optional(),
    adresseFacturation: Adresse.optional(),
    conditionsPaiement: z.string().max(200).optional(),
    contact: z.object({ nom: z.string().trim().min(2), email: z.string().email(), telephone: z.string().optional() }),
    forfait: z
      .object({
        m2Inclus: z.number().positive().max(100000),
        prixMensuelCents: z.number().int().nonnegative(),
        prixM2DepassementCents: z.number().int().nonnegative(),
        livraisonsIncluses: z.number().int().min(0).max(100).default(0),
        dateDebut: isoDate.optional(),
        engagementMois: z.number().int().min(0).max(120).optional(),
      })
      .optional(),
    projets: z.array(z.string().trim().min(2).max(200)).max(50).default([]),
  })
  .superRefine((b, ctx) => {
    if (b.type === 'B2B' && !b.siret) ctx.addIssue({ code: 'custom', path: ['siret'], message: 'SIRET obligatoire pour une entreprise' });
    if (b.siret && !isValidSiret(b.siret)) ctx.addIssue({ code: 'custom', path: ['siret'], message: 'SIRET invalide (14 chiffres, clé de contrôle)' });
    if (b.tvaIntracom && b.tvaIntracom.toUpperCase().startsWith('FR') && !isValidFrenchVat(b.tvaIntracom)) {
      ctx.addIssue({ code: 'custom', path: ['tvaIntracom'], message: 'Numéro de TVA invalide' });
    }
  });

/**
 * Back-Office (§3.B) pour le personnel de l'exploitant : tableau de bord des demandes (FLX-01), fiche de demande
 * et planning des missions par ressource (FLX-02, FLX-03), comptes clients (CLI-01).
 * Les actions (confirmer, contre-proposer, affecter) réutilisent les routes métier existantes.
 */
@Controller('bo')
export class BackofficeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Invitation du contact d'un client (CLI-01, ADM-03) ; le lien n'est renvoyé que si aucun service d'e-mail n'est configuré. */
  private async invite(tx: Tx, user: AuthUser, utilisateurId: string, entrepriseId: string) {
    const inv = await createInvitation(tx, { tenantId: user.tenantId, utilisateurId, entrepriseId, createdBy: user.id, invitePar: 'L’équipe JAMYSTOCK', publicUrl: this.config.publicUrl });
    return { expireLe: inv.expireLe, ...(this.config.mail.brevoApiKey ? {} : { lien: inv.lien }) };
  }

  @Post('clients/:id/users/:userId/invite')
  @HttpCode(200)
  @RequirePermission('client.manage')
  resendInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    const entrepriseId = uuid.parse(id);
    const uid = uuid.parse(userId);
    return this.db.tx(ctxOf(user), async (tx) => {
      const u = (await tx.query<{ statut: string }>('SELECT statut FROM utilisateur WHERE id = $1 AND entreprise_id = $2', [uid, entrepriseId])).rows[0];
      if (!u) throw notFound('Utilisateur');
      if (u.statut !== 'INVITE') throw conflict('DEJA_ACTIF', 'Cet utilisateur a déjà activé son accès');
      const r = await this.invite(tx, user, uid, entrepriseId);
      await this.audit.record(tx, user, { action: 'INVITATION_RENVOYEE', objet: 'utilisateur', objetId: uid, entrepriseId });
      return r;
    });
  }

  /** Référentiels des filtres et de l'en-tête. */
  @Get('context')
  @RequirePermission('mission.assign')
  context(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => ({
      depots: (await tx.query(`SELECT id, nom, code FROM depot ORDER BY nom`)).rows,
      clients: (await tx.query(`SELECT id, nom, type FROM entreprise WHERE statut = 'ACTIF' ORDER BY nom`)).rows,
      today: new Date().toISOString().slice(0, 10),
    }));
  }

  /** FLX-01 : toutes les demandes hors brouillons, avec badge « urgent » si la date souhaitée est à moins de 48 h. */
  @Get('orders')
  @RequirePermission('mission.assign')
  orders(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const now = new Date();
    const f = OrdersQuery.parse(query);
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query(
        `SELECT c.id, c.numero, c.type, c.statut, c.entreprise_id AS "clientId", e.nom AS client, e.type AS "typeClient",
                p.nom AS projet, d.nom AS depot, c.date_souhaitee AS "dateSouhaitee", c.creneau_souhaite AS "creneauSouhaite",
                c.date_confirmee AS "dateConfirmee", c.creneau_confirme AS "creneauConfirme", c.date_contre_proposee AS "dateContreProposee",
                c.adresse->>'libelle' AS adresse, c.volume_m3 AS "volumeM3", c.created_at AS "creeLe",
                (SELECT count(*)::int FROM ligne_commande l WHERE l.commande_id = c.id) AS "nbLignes",
                (SELECT count(*)::int FROM mission m WHERE m.commande_id = c.id AND m.statut = 'A_AFFECTER') AS "missionsAAffecter",
                (c.statut IN ${OPEN} AND coalesce(c.date_confirmee, c.date_souhaitee) < ($1::timestamptz + interval '48 hours')::date) AS urgent
           FROM commande c JOIN entreprise e ON e.id = c.entreprise_id
           LEFT JOIN projet p ON p.id = c.projet_id LEFT JOIN depot d ON d.id = c.depot_id
          WHERE c.statut <> 'BROUILLON'
            AND ($2::statut_commande IS NULL OR c.statut = $2) AND ($3::type_commande IS NULL OR c.type = $3)
            AND ($4::uuid IS NULL OR c.entreprise_id = $4) AND ($5::uuid IS NULL OR c.depot_id = $5)
            AND ($6::date IS NULL OR coalesce(c.date_confirmee, c.date_souhaitee) >= $6)
            AND ($7::date IS NULL OR coalesce(c.date_confirmee, c.date_souhaitee) <= $7)
            AND ($8::text IS NULL OR c.numero ILIKE '%' || $8 || '%' OR e.nom ILIKE '%' || $8 || '%' OR p.nom ILIKE '%' || $8 || '%')
          ORDER BY urgent DESC, coalesce(c.date_confirmee, c.date_souhaitee) NULLS LAST, c.created_at
          LIMIT 500`,
        [now.toISOString(), f.statut ?? null, f.type ?? null, f.client ?? null, f.depot ?? null, f.du ?? null, f.au ?? null, f.q ?? null],
      );
      return { items: rows.rows, total: rows.rows.length };
    });
  }

  /** Fiche d'une demande pour le dispatch : contenu, accès, frise et missions. */
  @Get('orders/:id')
  @RequirePermission('mission.assign')
  order(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const orderId = uuid.parse(id);
    return this.db.tx(ctxOf(user), async (tx) => {
      const c = (
        await tx.query(
          `SELECT c.id, c.numero, c.type, c.statut, c.entreprise_id AS "clientId", e.nom AS client, e.type AS "typeClient",
                  p.nom AS projet, d.nom AS depot, u.nom AS demandeur, u.email AS "demandeurEmail",
                  c.adresse, c.contraintes_acces AS "contraintesAcces", c.contact_site AS "contactSite",
                  c.date_souhaitee AS "dateSouhaitee", c.creneau_souhaite AS "creneauSouhaite", c.date_confirmee AS "dateConfirmee",
                  c.creneau_confirme AS "creneauConfirme", c.date_contre_proposee AS "dateContreProposee", c.message_dispatcher AS "messageDispatcher",
                  c.motif_refus AS "motifRefus", c.volume_m3 AS "volumeM3", c.poids_kg AS "poidsKg", c.vehicule_suggere AS "vehiculeSuggere",
                  c.description_collecte AS "descriptionCollecte", c.historique_statuts AS historique, c.created_at AS "creeLe"
             FROM commande c JOIN entreprise e ON e.id = c.entreprise_id JOIN utilisateur u ON u.id = c.demandeur_id
             LEFT JOIN projet p ON p.id = c.projet_id LEFT JOIN depot d ON d.id = c.depot_id
            WHERE c.id = $1 AND c.statut <> 'BROUILLON'`,
          [orderId],
        )
      ).rows[0];
      if (!c) throw notFound('Demande');
      const lignes = await tx.query<{ photoId: string | null }>(
        `SELECT l.id, l.statut_ligne AS "statutLigne", l.description_libre AS "descriptionLibre", l.quantite_estimee AS "quantite",
                a.id AS "articleId", a.libelle, a.qr_code AS "qrCode", a.statut AS "statutArticle", em.chemin AS localisation,
                (SELECT ph.id FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le LIMIT 1) AS "photoId"
           FROM ligne_commande l LEFT JOIN article a ON a.id = l.article_id LEFT JOIN emplacement em ON em.id = a.emplacement_courant_id
          WHERE l.commande_id = $1 ORDER BY em.chemin NULLS LAST, a.libelle`,
        [orderId],
      );
      const missions = await missionsWhere(tx, 'm.commande_id = $1', [orderId]);
      return {
        ...c,
        lignes: lignes.rows.map(({ photoId, ...l }) => ({ ...l, vignette: photoId ? this.files.photoUrl(user.tenantId, photoId, 't') : null })),
        missions,
      };
    });
  }

  /**
   * FLX-03 : planning d'une journée par ressource. Les missions encore non affectées dont la date est déjà passée
   * (avant aujourd'hui) remontent aussi, pour ne rien laisser tomber.
   */
  @Get('planning')
  @RequirePermission('mission.assign')
  planning(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const day = date ? isoDate.parse(date) : new Date().toISOString().slice(0, 10);
    return this.db.tx(ctxOf(user), async (tx) => ({
      date: day,
      missions: await missionsWhere(
        tx,
        `m.statut <> 'ANNULEE' AND ((m.debut_prevu AT TIME ZONE 'Europe/Paris')::date = $1
           OR (m.statut = 'A_AFFECTER' AND (m.debut_prevu AT TIME ZONE 'Europe/Paris')::date < LEAST($1::date, (now() AT TIME ZONE 'Europe/Paris')::date)))`,
        [day],
      ),
      ressources: (
        await tx.query(
          `SELECT id, nom, role FROM utilisateur WHERE role IN ('DRIVER','OPERATOR') AND statut = 'ACTIF' ORDER BY role, nom`,
        )
      ).rows,
      vehicules: (
        await tx.query(`SELECT id, immatriculation, type, volume_m3 AS "volumeM3", charge_utile_kg AS "chargeUtileKg" FROM vehicule WHERE actif ORDER BY volume_m3`)
      ).rows,
    }));
  }

  /** Tableau de bord : compteurs du jour. */
  @Get('summary')
  @RequirePermission('mission.assign')
  summary(@CurrentUser() user: AuthUser) {
    const now = new Date();
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM commande WHERE statut = 'SOUMISE') AS "aConfirmer",
           (SELECT count(*)::int FROM commande WHERE statut = 'SOUMISE' AND date_contre_proposee IS NOT NULL) AS "contrePropositions",
           (SELECT count(*)::int FROM commande WHERE statut IN ${OPEN} AND coalesce(date_confirmee, date_souhaitee) < ($1::timestamptz + interval '48 hours')::date) AS urgentes,
           (SELECT count(*)::int FROM mission WHERE statut = 'A_AFFECTER') AS "missionsAAffecter",
           (SELECT count(*)::int FROM mission WHERE statut IN ('AFFECTEE','EN_COURS') AND (debut_prevu AT TIME ZONE 'Europe/Paris')::date = ($1::timestamptz AT TIME ZONE 'Europe/Paris')::date) AS "missionsDuJour",
           (SELECT count(*)::int FROM article WHERE statut IN ('EN_STOCK','RESERVE','EN_PREPARATION')) AS "articlesEnStock",
           (SELECT count(*)::int FROM entreprise WHERE statut = 'ACTIF') AS clients`,
        [now.toISOString()],
      );
      return r.rows[0];
    });
  }

  // ---------------------------------------------------------------- clients (CLI-01)

  @Get('clients')
  @RequirePermission('mission.assign')
  clients(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query<{ id: string; type: string }>(
        `SELECT e.id, e.nom, e.type, e.siret, e.statut, e.created_at AS "creeLe",
                (SELECT count(*)::int FROM projet p WHERE p.entreprise_id = e.id) AS "nbProjets",
                (SELECT count(*)::int FROM utilisateur u WHERE u.entreprise_id = e.id AND u.statut <> 'DESACTIVE') AS "nbUtilisateurs",
                (SELECT count(*)::int FROM commande c WHERE c.entreprise_id = e.id AND c.statut IN ${OPEN}) AS "demandesEnCours"
           FROM entreprise e ORDER BY e.nom`,
      );
      const items = [];
      for (const e of rows.rows) {
        const s = await liveSurface(tx, e.id);
        items.push({ ...e, nbArticles: s.nbArticles, m2Occupes: s.m2Occupes, m2Inclus: s.m2Inclus, taux: s.taux, niveau: s.niveau });
      }
      return { items };
    });
  }

  @Get('clients/:id')
  @RequirePermission('mission.assign')
  client(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const entrepriseId = uuid.parse(id);
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = (
        await tx.query(
          `SELECT id, nom, type, siret, tva_intracom AS "tvaIntracom", adresse_facturation AS "adresseFacturation",
                  conditions_paiement AS "conditionsPaiement", statut, created_at AS "creeLe",
                  email_facturation AS "emailFacturation", bon_de_commande AS "bonDeCommande", moyen_paiement AS "moyenPaiement",
                  moyen_paiement_detail AS "moyenDetail" FROM entreprise WHERE id = $1`,
          [entrepriseId],
        )
      ).rows[0];
      if (!e) throw notFound('Client');
      const projets = await tx.query(
        `SELECT p.id, p.nom, p.statut, (SELECT count(*)::int FROM article a WHERE a.projet_id = p.id AND a.statut IN ('EN_STOCK','RESERVE','EN_PREPARATION')) AS "nbArticles"
           FROM projet p WHERE p.entreprise_id = $1 ORDER BY p.nom`,
        [entrepriseId],
      );
      const utilisateurs = await tx.query(
        `SELECT id, nom, email, role, statut, derniere_connexion AS "derniereConnexion" FROM utilisateur WHERE entreprise_id = $1 ORDER BY role, nom`,
        [entrepriseId],
      );
      const forfait = await tx.query(
        `SELECT f.id, f.version, f.m2_inclus AS "m2Inclus", f.prix_mensuel_cents AS "prixMensuelCents",
                f.prix_m2_depassement_cents AS "prixM2DepassementCents", f.prestations_incluses AS "prestationsIncluses",
                f.date_debut AS "dateDebut", f.date_fin AS "dateFin", f.engagement_mois AS "engagementMois", g.nom AS grille
           FROM forfait f JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id
          WHERE f.entreprise_id = $1 AND f.statut = 'ACTIF' ORDER BY f.version DESC LIMIT 1`,
        [entrepriseId],
      );
      return { ...e, projets: projets.rows, utilisateurs: utilisateurs.rows, forfait: forfait.rows[0] ?? null, surface: await liveSurface(tx, entrepriseId) };
    });
  }

  /**
   * CLI-01 : ouverture d'un compte client. Le contact principal est créé « invité » (sans mot de passe) et reçoit
   * le lien d'activation par e-mail (ADM-03).
   */
  @Post('clients')
  @RequirePermission('client.manage')
  createClient(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = ClientBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO entreprise (id, tenant_id, type, nom, siret, tva_intracom, adresse_facturation, conditions_paiement, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          user.tenantId,
          b.type,
          b.nom,
          b.siret ? normalizeSiret(b.siret) : null,
          b.tvaIntracom ? b.tvaIntracom.replace(/\s/g, '').toUpperCase() : null,
          b.adresseFacturation ?? null,
          b.conditionsPaiement ?? null,
          user.id,
        ],
      );
      const contactId = uuidv7();
      await tx.query(
        `INSERT INTO utilisateur (id, tenant_id, entreprise_id, email, telephone, nom, role, statut, created_by)
         VALUES ($1,$2,$3,lower($4),$5,$6,$7,'INVITE',$8)`,
        [contactId, user.tenantId, id, b.contact.email, b.contact.telephone ?? null, b.contact.nom, b.type === 'B2B' ? 'B2B_ADMIN' : 'B2C', user.id],
      );
      for (const nom of b.type === 'B2B' ? b.projets : []) {
        await tx.query(`INSERT INTO projet (id, tenant_id, entreprise_id, nom, created_by) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), user.tenantId, id, nom, user.id]);
      }
      if (b.forfait) {
        const grille = (
          await tx.query<{ id: string }>(
            `SELECT id FROM grille_tarifaire WHERE type = $1 AND valide_du <= current_date AND (valide_au IS NULL OR valide_au >= current_date)
              ORDER BY version DESC LIMIT 1`,
            [b.type === 'B2B' ? 'SUR_MESURE_B2B' : 'STANDARD_B2C'],
          )
        ).rows[0];
        if (!grille) throw unprocessable('GRILLE_ABSENTE', 'Aucune grille tarifaire en vigueur pour ce type de client');
        await tx.query(
          `INSERT INTO forfait (id, tenant_id, entreprise_id, grille_tarifaire_id, m2_inclus, prix_mensuel_cents, prix_m2_depassement_cents,
                                prestations_incluses, date_debut, engagement_mois, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date, current_date),$10,$11)`,
          [
            uuidv7(),
            user.tenantId,
            id,
            grille.id,
            b.forfait.m2Inclus,
            b.forfait.prixMensuelCents,
            b.forfait.prixM2DepassementCents,
            JSON.stringify(b.forfait.livraisonsIncluses ? { LIVRAISON: b.forfait.livraisonsIncluses } : {}),
            b.forfait.dateDebut ?? null,
            b.forfait.engagementMois ?? null,
            user.id,
          ],
        );
      }
      const invitation = await this.invite(tx, user, contactId, id);
      await this.audit.record(tx, user, { action: 'CLIENT_CREE', objet: 'entreprise', objetId: id, entrepriseId: id, apres: { ...b, contact: { ...b.contact } } });
      return { id, invitation };
    });
  }

  @Post('clients/:id/projets')
  @RequirePermission('client.manage')
  createProject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const entrepriseId = uuid.parse(id);
    const b = z.object({ nom: z.string().trim().min(2).max(200), adresseSite: Adresse.optional() }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = (await tx.query<{ type: string }>('SELECT type FROM entreprise WHERE id = $1', [entrepriseId])).rows[0];
      if (!e) throw notFound('Client');
      if (e.type !== 'B2B') throw unprocessable('PROJETS_B2B', 'Les projets concernent les clients professionnels');
      const projetId = uuidv7();
      await tx.query(`INSERT INTO projet (id, tenant_id, entreprise_id, nom, adresse_site, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
        projetId,
        user.tenantId,
        entrepriseId,
        b.nom,
        b.adresseSite ?? null,
        user.id,
      ]);
      await this.audit.record(tx, user, { action: 'PROJET_CREE', objet: 'projet', objetId: projetId, entrepriseId, apres: b });
      return { id: projetId };
    });
  }
}

/** Missions avec ce qu'il faut pour les placer : demande, client, adresse, ressource, véhicule, charge. */
async function missionsWhere(tx: Tx, where: string, params: unknown[]) {
  return (
    await tx.query(
      `SELECT m.id, m.type, m.statut, m.debut_prevu AS "debutPrevu", m.ordre, m.assigne_a AS "assigneA", u.nom AS "assigneNom",
              m.vehicule_id AS "vehiculeId", v.immatriculation AS vehicule, c.id AS "commandeId", c.numero, c.type AS "typeCommande",
              c.statut AS "statutCommande", e.nom AS client, c.adresse->>'libelle' AS adresse, coalesce(c.creneau_confirme, c.creneau_souhaite) AS creneau,
              c.volume_m3 AS "volumeM3", c.poids_kg AS "poidsKg", c.vehicule_suggere AS "vehiculeSuggere",
              (SELECT count(*)::int FROM ligne_commande l WHERE l.commande_id = c.id) AS "nbLignes"
         FROM mission m LEFT JOIN commande c ON c.id = m.commande_id LEFT JOIN entreprise e ON e.id = c.entreprise_id
         LEFT JOIN utilisateur u ON u.id = m.assigne_a LEFT JOIN vehicule v ON v.id = m.vehicule_id
        WHERE ${where}
        ORDER BY m.debut_prevu, m.ordre NULLS LAST, m.type`,
      params,
    )
  ).rows;
}

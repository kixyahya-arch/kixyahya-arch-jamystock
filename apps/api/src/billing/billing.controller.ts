import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { addIsoDays, clientAccountCode, fecEntries, fecFile, monthBounds, parisClock, uuidv7, type AccountingInvoice, type AccountingPayment } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from './billing.service.js';
import { BillingScheduler } from './billing.scheduler.js';
import { DunningService, dunningSettings } from './dunning.service.js';

const uuid = z.string().uuid();
const isoDate = z.string().date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois au format AAAA-MM');
const motif = z.string().trim().min(3, 'Motif obligatoire (3 caractères minimum)').max(500);
const cents = z.number().int().min(0).max(100_000_000);

const InvoicesQuery = z.object({
  statut: z.enum(['BROUILLON', 'EMISE', 'PAYEE', 'EN_RETARD', 'ANNULEE', 'IMPAYEE']).optional(),
  type: z.enum(['FACTURE', 'AVOIR']).optional(),
  client: uuid.optional(),
  mois: month.optional(),
  q: z.string().trim().min(1).max(60).optional(),
});

const GrilleLigne = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,40}$/, 'Code en majuscules (ex. LIVRAISON_ZONE1)'),
  libelle: z.string().trim().min(2).max(120),
  unite: z.string().trim().min(1).max(30),
  prix_ht_cents: cents,
  tva: z.number().min(0).max(30),
});
const GrilleBody = z.object({
  nom: z.string().trim().min(2).max(120),
  type: z.enum(['STANDARD_B2C', 'SUR_MESURE_B2B']),
  valideDu: isoDate,
  prixM2MoisCents: cents,
  m2Minimum: z.number().min(0).max(10000).default(0),
  lignes: z.array(GrilleLigne).max(40),
});

const ForfaitBody = z.object({
  entrepriseId: uuid,
  grilleId: uuid,
  m2Inclus: z.number().positive().max(100000),
  prixMensuelCents: cents,
  prixM2DepassementCents: cents,
  prestationsIncluses: z.record(z.string().regex(/^[A-Z0-9_]{2,40}$/), z.number().int().min(0).max(1000)).default({}),
  modeSurface: z.enum(['MOYENNE', 'PIC']).default('MOYENNE'),
  coefficientDegagement: z.number().min(1).max(2).default(1.15),
  m2Minimum: z.number().min(0).max(10000).default(0),
  dateDebut: isoDate,
  engagementMois: z.number().int().min(0).max(120).optional(),
  motif: motif.optional(),
});

/**
 * Facturation dans le Back-Office (§3.B, FAC-01 à FAC-04), réservée au Super Admin (permission pricing.manage) :
 * le Dispatcher n'a accès ni aux tarifs ni aux montants (§2.2).
 */
@Controller('bo/billing')
export class BillingController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingScheduler) private readonly scheduler: BillingScheduler,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DunningService) private readonly dunning: DunningService,
  ) {}

  /** Indicateurs de l'écran Facturation. */
  @Get('summary')
  @RequirePermission('pricing.manage')
  summary(@CurrentUser() user: AuthUser) {
    const today = parisClock(new Date()).date;
    const m = monthBounds(today.slice(0, 7));
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = (
        await tx.query(
          `SELECT count(*) FILTER (WHERE statut = 'BROUILLON')::int AS brouillons,
                  count(*) FILTER (WHERE statut = 'BROUILLON' AND bloquee)::int AS bloquees,
                  count(*) FILTER (WHERE type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD'))::int AS "aEncaisser",
                  coalesce(sum(total_ttc_cents) FILTER (WHERE type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD')), 0)::bigint AS "aEncaisserCents",
                  count(*) FILTER (WHERE type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD') AND echeance < $1)::int AS "enRetard",
                  coalesce(sum(total_ht_cents) FILTER (WHERE statut <> 'BROUILLON' AND (emise_le AT TIME ZONE 'Europe/Paris')::date BETWEEN $2 AND $3), 0)::bigint AS "emisMoisHtCents",
                  min(emission_prevue) FILTER (WHERE statut = 'BROUILLON' AND NOT bloquee) AS "prochaineEmission"
             FROM facture`,
          [today, m.start, m.end],
        )
      ).rows[0];
      const last = (await tx.query(`SELECT max(date)::text AS d FROM instantane_occupation WHERE projet_id IS NULL AND depot_id IS NULL`)).rows[0];
      return { ...r, aEncaisserCents: Number(r.aEncaisserCents), emisMoisHtCents: Number(r.emisMoisHtCents), dernierInstantane: last.d, today };
    });
  }

  @Get('invoices')
  @RequirePermission('pricing.manage')
  invoices(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const f = InvoicesQuery.parse(query);
    const today = parisClock(new Date()).date;
    const m = f.mois ? monthBounds(f.mois) : null;
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query(
        `SELECT f.id, f.numero, f.type, f.statut, f.entreprise_id AS "clientId", e.nom AS client, e.type AS "typeClient",
                f.periode_debut AS "periodeDebut", f.periode_fin AS "periodeFin", f.m2_factures AS "m2Factures",
                f.total_ht_cents AS "totalHtCents", f.total_ttc_cents AS "totalTtcCents", f.emise_le AS "emiseLe", f.echeance,
                f.emission_prevue AS "emissionPrevue", f.bloquee, f.motif_blocage AS "motifBlocage", f.paye_le AS "payeLe",
                o.numero AS "origineNumero", f.relance_niveau AS "relanceNiveau",
                (f.type = 'FACTURE' AND f.statut IN ('EMISE','EN_RETARD') AND f.echeance < $1) AS "enRetard"
           FROM facture f JOIN entreprise e ON e.id = f.entreprise_id LEFT JOIN facture o ON o.id = f.facture_origine_id
          WHERE ($2::text IS NULL OR ($2 = 'IMPAYEE' AND f.type = 'FACTURE' AND f.statut IN ('EMISE','EN_RETARD')) OR f.statut::text = $2)
            AND ($3::type_facture IS NULL OR f.type = $3) AND ($4::uuid IS NULL OR f.entreprise_id = $4)
            AND ($5::date IS NULL OR coalesce(f.periode_debut, (f.emise_le AT TIME ZONE 'Europe/Paris')::date) BETWEEN $5 AND $6)
            AND ($7::text IS NULL OR f.numero ILIKE '%' || $7 || '%' OR e.nom ILIKE '%' || $7 || '%')
          ORDER BY (f.statut = 'BROUILLON') DESC, coalesce(f.emise_le, f.created_at) DESC, e.nom
          LIMIT 500`,
        [today, f.statut ?? null, f.type ?? null, f.client ?? null, m?.start ?? null, m?.end ?? null, f.q ?? null],
      );
      return { items: rows.rows, total: rows.rows.length };
    });
  }

  @Get('invoices/:id')
  @RequirePermission('pricing.manage')
  invoice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const fid = uuid.parse(id);
    return this.db.tx(ctxOf(user), async (tx) => {
      const f = (
        await tx.query(
          `SELECT f.id, f.numero, f.type, f.statut, f.entreprise_id AS "clientId", e.nom AS client, e.type AS "typeClient",
                  e.conditions_paiement AS "conditionsPaiement", f.periode_debut AS "periodeDebut", f.periode_fin AS "periodeFin",
                  f.m2_factures AS "m2Factures", f.total_ht_cents AS "totalHtCents", f.tva_cents AS "tvaCents", f.total_ttc_cents AS "totalTtcCents",
                  f.emise_le AS "emiseLe", f.echeance, f.emission_prevue AS "emissionPrevue", f.bloquee, f.motif_blocage AS "motifBlocage",
                  f.motif, f.paye_le AS "payeLe", f.empreinte_sha256 AS empreinte, f.relance_niveau AS "relanceNiveau", f.derniere_relance_le AS "derniereRelanceLe", f.bon_de_commande AS "bonDeCommande",
                  f.facture_origine_id AS "origineId", o.numero AS "origineNumero",
                  fo.m2_inclus AS "m2Inclus", fo.prix_mensuel_cents AS "prixMensuelCents", fo.prix_m2_depassement_cents AS "prixM2DepassementCents",
                  fo.prestations_incluses AS "prestationsIncluses", fo.mode_surface AS "modeSurface"
             FROM facture f JOIN entreprise e ON e.id = f.entreprise_id LEFT JOIN facture o ON o.id = f.facture_origine_id
             LEFT JOIN forfait fo ON fo.id = f.forfait_id
            WHERE f.id = $1`,
          [fid],
        )
      ).rows[0];
      if (!f) throw notFound('Facture');
      const lignes = await tx.query(
        `SELECT id, type, libelle, quantite, unite, prix_unitaire_ht_cents AS "prixUnitaireHtCents", taux_tva AS "tauxTva",
                total_ht_cents AS "totalHtCents", source_id AS "sourceId" FROM ligne_facture WHERE facture_id = $1 ORDER BY ordre`,
        [fid],
      );
      const avoirs = await tx.query(
        `SELECT id, numero, total_ht_cents AS "totalHtCents", total_ttc_cents AS "totalTtcCents", emise_le AS "emiseLe", motif
           FROM facture WHERE facture_origine_id = $1 ORDER BY emise_le`,
        [fid],
      );
      const paiements = await tx.query(`SELECT moyen, montant_cents AS "montantCents", date, reference_psp AS reference FROM paiement WHERE facture_id = $1 ORDER BY date`, [fid]);
      const jours = f.periodeDebut
        ? (
            await tx.query(
              `SELECT date::text, m2_occupes AS m2, source, recalcul_motif AS motif FROM instantane_occupation
                WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $2 AND $3 ORDER BY date`,
              [f.clientId, f.periodeDebut, f.periodeFin],
            )
          ).rows
        : [];
      const historique = await tx.query(
        `SELECT j.action, j.motif, j.horodatage AS le, u.nom AS acteur FROM journal_audit j LEFT JOIN utilisateur u ON u.id = j.acteur_id
          WHERE j.objet = 'facture' AND j.objet_id = $1 ORDER BY j.horodatage`,
        [fid],
      );
      const relances = await this.dunning.history(tx, fid);
      return { ...f, lignes: lignes.rows, avoirs: avoirs.rows, paiements: paiements.rows, jours, historique: historique.rows, relances };
    });
  }

  @Get('invoices/:id/pdf')
  @RequirePermission('pricing.manage')
  async pdf(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const file = await this.db.tx(ctxOf(user), (tx) => this.billing.invoiceFile(tx, uuid.parse(id)));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  }

  /** Génère (ou recalcule) les brouillons d'un mois, pour tous les clients ou un seul. */
  @Post('drafts')
  @RequirePermission('pricing.manage')
  drafts(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = z.object({ mois: month, entrepriseId: uuid.optional() }).parse(body);
    const today = parisClock(new Date()).date;
    if (monthBounds(b.mois).start > today) throw unprocessable('MOIS_FUTUR', 'On ne facture pas un mois qui n’a pas commencé');
    return this.db.tx(ctxOf(user), (tx) => this.billing.generateDrafts(tx, user.tenantId, user, b.mois, new Date(), b.entrepriseId));
  }

  @Post('invoices/:id/issue')
  @RequirePermission('pricing.manage')
  issue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), (tx) => this.billing.issue(tx, user.tenantId, user, uuid.parse(id), new Date()));
  }

  @Post('invoices/:id/block')
  @RequirePermission('pricing.manage')
  async block(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = z.object({ bloquee: z.boolean(), motif: z.string().trim().max(500).optional() }).parse(body);
    await this.db.tx(ctxOf(user), (tx) => this.billing.setBlocked(tx, user, uuid.parse(id), b.bloquee, b.motif));
    return { ok: true };
  }

  @Post('invoices/:id/lines')
  @RequirePermission('pricing.manage')
  async addLine(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = z
      .object({
        libelle: z.string().trim().min(2).max(200),
        quantite: z.number().positive().max(100000),
        unite: z.string().trim().min(1).max(30),
        prixUnitaireHtCents: z.number().int().min(-100_000_000).max(100_000_000),
        tauxTva: z.number().min(0).max(30).default(20),
        motif,
      })
      .parse(body);
    await this.db.tx(ctxOf(user), (tx) => this.billing.addLine(tx, user, uuid.parse(id), b));
    return { ok: true };
  }

  @Post('invoices/:id/lines/:lineId/remove')
  @RequirePermission('pricing.manage')
  async removeLine(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
    const b = z.object({ motif }).parse(body);
    await this.db.tx(ctxOf(user), (tx) => this.billing.removeLine(tx, user, uuid.parse(id), uuid.parse(lineId), b.motif));
    return { ok: true };
  }

  @Post('invoices/:id/credit')
  @RequirePermission('pricing.manage')
  credit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = z.object({ montantHtCents: z.number().int().positive().optional(), motif }).parse(body);
    return this.db.tx(ctxOf(user), (tx) => this.billing.credit(tx, user, uuid.parse(id), b, new Date()));
  }

  @Post('invoices/:id/paid')
  @RequirePermission('pricing.manage')
  async paid(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = z.object({ date: isoDate, moyen: z.enum(['VIREMENT', 'SEPA', 'CB', 'CHEQUE']), reference: z.string().trim().max(100).optional() }).parse(body);
    await this.db.tx(ctxOf(user), (tx) => this.billing.markPaid(tx, user, uuid.parse(id), b));
    return { ok: true };
  }

  /** Instantanés quotidiens d'un client (FAC-02) : base de la facture, avec leur origine. */
  @Get('occupation')
  @RequirePermission('pricing.manage')
  occupation(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const today = parisClock(new Date()).date;
    const q = z.object({ client: uuid, du: isoDate.optional(), au: isoDate.optional() }).parse(query);
    const au = q.au ?? today;
    const du = q.du ?? addIsoDays(au, -59);
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query(
        `SELECT date::text, m2_occupes AS m2, nb_articles AS "nbArticles", source, recalcul_motif AS motif FROM instantane_occupation
          WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $2 AND $3 ORDER BY date`,
        [q.client, du, au],
      );
      const forfait = (
        await tx.query(
          `SELECT m2_inclus AS "m2Inclus", mode_surface AS "modeSurface" FROM forfait WHERE entreprise_id = $1 AND statut = 'ACTIF'
              AND date_debut <= $2 AND (date_fin IS NULL OR date_fin >= $2) ORDER BY version DESC LIMIT 1`,
          [q.client, au],
        )
      ).rows[0];
      return { du, au, jours: rows.rows, m2Inclus: forfait?.m2Inclus ?? null };
    });
  }

  @Post('occupation/correct')
  @RequirePermission('pricing.manage')
  correct(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = z.object({ entrepriseId: uuid, du: isoDate, au: isoDate, m2: z.number().min(0).max(100000), motif }).parse(body);
    if (b.au >= parisClock(new Date()).date) throw unprocessable('PERIODE', 'Seuls les jours passés se corrigent');
    return this.billing.correctSnapshot(user, b);
  }

  /** Passe immédiate des tâches planifiées (rattrapage des instantanés, brouillons dus, émissions à J+2). */
  @Post('run')
  @RequirePermission('pricing.manage')
  run(@CurrentUser() user: AuthUser) {
    return this.scheduler.runFor(user.tenantId, new Date());
  }

  // ---------------------------------------------------------------------------------------------------------
  // FAC-05 : relances des impayés
  // ---------------------------------------------------------------------------------------------------------

  /** Relance manuelle d'une facture impayée (e-mail au contact facturation ou aux administrateurs du client). */
  @Post('invoices/:id/remind')
  @RequirePermission('pricing.manage')
  remind(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.dunning.remind(user, uuid.parse(id));
  }

  @Get('settings')
  @RequirePermission('pricing.manage')
  settings(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => ({ relances: await dunningSettings(tx) }));
  }

  /** Réglages des relances. Le blocage des restitutions reste désactivé par défaut : sa base juridique est à valider. */
  @Put('settings')
  @RequirePermission('pricing.manage')
  saveSettings(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = z.object({ relances: z.object({ actives: z.boolean(), blocageRestitutions: z.boolean() }) }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const avant = await dunningSettings(tx);
      await tx.query(`UPDATE organisation SET parametres = jsonb_set(parametres, '{relances}', $2::jsonb), updated_at = now() WHERE id = $1`, [user.tenantId, JSON.stringify(b.relances)]);
      await this.audit.record(tx, user, { action: 'REGLAGES_RELANCES', objet: 'organisation', objetId: user.tenantId, avant, apres: b.relances });
      return { relances: b.relances };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // FAC-06 : export des écritures vers l'outil comptable
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Fichier des écritures comptables d'une période : factures et avoirs émis au journal des ventes, règlements au
   * journal de banque. `format=fec` produit le fichier normalisé (tabulations), `format=csv` la même chose en
   * point-virgule, lisible dans un tableur.
   */
  @Get('export')
  @RequirePermission('pricing.manage')
  async exportEntries(@CurrentUser() user: AuthUser, @Query() query: unknown, @Res() res: Response) {
    const q = z.object({ du: isoDate, au: isoDate, format: z.enum(['fec', 'csv']).default('fec') }).parse(query);
    if (q.au < q.du) throw unprocessable('PERIODE', 'La fin de période précède le début');
    if (q.du < addIsoDays(q.au, -400)) throw unprocessable('PERIODE', 'Exportez au plus un exercice (13 mois) à la fois');
    const out = await this.db.tx(ctxOf(user), async (tx) => {
      const org = (await tx.query<{ siret: string | null }>('SELECT siret FROM organisation WHERE id = $1', [user.tenantId])).rows[0];
      const inv = await tx.query<{ id: string; numero: string; type: 'FACTURE' | 'AVOIR'; emise: string; total_ttc_cents: number; cid: string; siret: string | null; nom: string }>(
        `SELECT f.id, f.numero, f.type, to_char(f.emise_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS emise, f.total_ttc_cents,
                e.id AS cid, e.siret, e.nom
           FROM facture f JOIN entreprise e ON e.id = f.entreprise_id
          WHERE f.statut <> 'BROUILLON' AND (f.emise_le AT TIME ZONE 'Europe/Paris')::date BETWEEN $1 AND $2`,
        [q.du, q.au],
      );
      const lines = await tx.query<{ facture_id: string; taux_tva: number; total_ht_cents: number }>(
        'SELECT facture_id, taux_tva::float AS taux_tva, total_ht_cents FROM ligne_facture WHERE facture_id = ANY($1)',
        [inv.rows.map((r) => r.id)],
      );
      const invoices: AccountingInvoice[] = inv.rows.map((r) => ({
        numero: r.numero,
        type: r.type,
        emiseLe: r.emise,
        client: { code: clientAccountCode({ siret: r.siret, id: r.cid }), nom: r.nom },
        lignes: lines.rows.filter((l) => l.facture_id === r.id).map((l) => ({ tauxTva: Number(l.taux_tva), totalHtCents: l.total_ht_cents })),
        totalTtcCents: r.total_ttc_cents,
      }));
      const pay = await tx.query<{ id: string; reference: string | null; date: string; moyen: string; montant_cents: number; numero: string; cid: string; siret: string | null; nom: string }>(
        `SELECT p.id, p.reference_psp AS reference, p.date::text AS date, p.moyen, p.montant_cents, f.numero, e.id AS cid, e.siret, e.nom
           FROM paiement p JOIN facture f ON f.id = p.facture_id JOIN entreprise e ON e.id = f.entreprise_id
          WHERE p.date BETWEEN $1 AND $2`,
        [q.du, q.au],
      );
      const payments: AccountingPayment[] = pay.rows.map((p) => ({
        reference: p.reference ?? `REG-${p.id.replace(/-/g, '').slice(-8).toUpperCase()}`,
        date: p.date,
        factureNumero: p.numero,
        client: { code: clientAccountCode({ siret: p.siret, id: p.cid }), nom: p.nom },
        montantCents: p.montant_cents,
        moyen: p.moyen,
      }));
      const entries = fecEntries(invoices, payments);
      await this.audit.record(tx, user, { action: 'EXPORT_COMPTABLE', objet: 'facture', apres: { du: q.du, au: q.au, format: q.format, factures: invoices.length, reglements: payments.length } });
      return { siren: (org?.siret ?? '').slice(0, 9), entries };
    });
    const body = fecFile(out.entries, q.format === 'fec' ? '\t' : ';');
    const name = q.format === 'fec' ? `${out.siren || '000000000'}FEC${q.au.replace(/-/g, '')}.txt` : `ecritures-${q.du}-${q.au}.csv`;
    res.setHeader('Content-Type', q.format === 'fec' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Ecritures', String(out.entries.length));
    // BOM pour qu'Excel lise les accents du CSV ; le FEC reste en UTF-8 sans BOM
    res.send(q.format === 'csv' ? `\uFEFF${body}` : body);
  }

  // ---------------------------------------------------------------------------------------------------------
  // FAC-01 : grilles tarifaires et forfaits
  // ---------------------------------------------------------------------------------------------------------

  @Get('grilles')
  @RequirePermission('pricing.manage')
  grilles(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query(
        `SELECT g.id, g.nom, g.type, g.version, g.valide_du AS "valideDu", g.valide_au AS "valideAu", g.prix_m2_mois_cents AS "prixM2MoisCents",
                g.m2_minimum AS "m2Minimum", g.lignes, g.utilisee,
                (SELECT count(*)::int FROM forfait f WHERE f.grille_tarifaire_id = g.id AND f.statut = 'ACTIF') AS "nbForfaits"
           FROM grille_tarifaire g ORDER BY g.nom, g.version DESC`,
      );
      return { items: rows.rows };
    });
  }

  /** Nouvelle grille, ou nouvelle version d'une grille existante (la précédente s'arrête la veille). */
  @Post('grilles')
  @RequirePermission('pricing.manage')
  createGrille(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = GrilleBody.extend({ baseId: uuid.optional() }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      let version = 1;
      let nom = b.nom;
      if (b.baseId) {
        const base = (await tx.query<{ nom: string; version: number; valide_du: string }>('SELECT nom, version, valide_du::text FROM grille_tarifaire WHERE id = $1 FOR UPDATE', [b.baseId])).rows[0];
        if (!base) throw notFound('Grille');
        const last = (await tx.query<{ v: number; d: string }>('SELECT max(version)::int AS v, max(valide_du)::text AS d FROM grille_tarifaire WHERE nom = $1', [base.nom])).rows[0]!;
        if (b.valideDu <= last.d) throw unprocessable('VALIDITE', `La nouvelle version doit commencer après le ${last.d}`);
        version = last.v + 1;
        nom = base.nom;
        await tx.query(`UPDATE grille_tarifaire SET valide_au = $2, updated_at = now() WHERE nom = $1 AND valide_au IS NULL`, [nom, addIsoDays(b.valideDu, -1)]);
      }
      const id = uuidv7();
      await tx.query(
        `INSERT INTO grille_tarifaire (id, tenant_id, nom, type, version, valide_du, prix_m2_mois_cents, m2_minimum, lignes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, user.tenantId, nom, b.type, version, b.valideDu, b.prixM2MoisCents, b.m2Minimum, JSON.stringify(b.lignes), user.id],
      );
      await this.audit.record(tx, user, { action: b.baseId ? 'GRILLE_VERSIONNEE' : 'GRILLE_CREEE', objet: 'grille_tarifaire', objetId: id, apres: { ...b, version } });
      return { id, version };
    });
  }

  /** Correction en place d'une grille jamais utilisée pour facturer ; sinon, il faut une nouvelle version. */
  @Put('grilles/:id')
  @RequirePermission('pricing.manage')
  updateGrille(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const gid = uuid.parse(id);
    const b = GrilleBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const g = (await tx.query('SELECT * FROM grille_tarifaire WHERE id = $1 FOR UPDATE', [gid])).rows[0];
      if (!g) throw notFound('Grille');
      if (g.utilisee) throw conflict('GRILLE_UTILISEE', 'Grille déjà utilisée pour facturer : créez une nouvelle version');
      await tx.query(
        `UPDATE grille_tarifaire SET nom = $2, type = $3, valide_du = $4, prix_m2_mois_cents = $5, m2_minimum = $6, lignes = $7, updated_at = now() WHERE id = $1`,
        [gid, b.nom, b.type, b.valideDu, b.prixM2MoisCents, b.m2Minimum, JSON.stringify(b.lignes)],
      );
      await this.audit.record(tx, user, { action: 'GRILLE_MODIFIEE', objet: 'grille_tarifaire', objetId: gid, avant: g, apres: b });
      return { id: gid };
    });
  }

  @Get('forfaits')
  @RequirePermission('pricing.manage')
  forfaits(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = z.object({ client: uuid.optional() }).parse(query);
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query(
        `SELECT f.id, f.entreprise_id AS "clientId", e.nom AS client, e.type AS "typeClient", f.version, f.statut, g.id AS "grilleId", g.nom AS grille, g.version AS "grilleVersion",
                f.m2_inclus AS "m2Inclus", f.prix_mensuel_cents AS "prixMensuelCents", f.prix_m2_depassement_cents AS "prixM2DepassementCents",
                f.prestations_incluses AS "prestationsIncluses", f.mode_surface AS "modeSurface", f.coefficient_degagement AS "coefficientDegagement",
                f.m2_minimum AS "m2Minimum", f.date_debut AS "dateDebut", f.date_fin AS "dateFin", f.engagement_mois AS "engagementMois"
           FROM forfait f JOIN entreprise e ON e.id = f.entreprise_id JOIN grille_tarifaire g ON g.id = f.grille_tarifaire_id
          WHERE ($1::uuid IS NULL OR f.entreprise_id = $1)
          ORDER BY e.nom, f.date_debut DESC`,
        [q.client ?? null],
      );
      return { items: rows.rows };
    });
  }

  /**
   * Nouveau forfait ou avenant (FAC-01 « versionné ») : le contrat en cours s'arrête la veille. Un tarif modifié
   * ne s'applique qu'aux périodes suivantes : impossible de démarrer dans une période déjà facturée.
   */
  @Post('forfaits')
  @RequirePermission('pricing.manage')
  createForfait(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = ForfaitBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const ent = (await tx.query('SELECT id FROM entreprise WHERE id = $1', [b.entrepriseId])).rows[0];
      if (!ent) throw notFound('Client');
      const grille = (await tx.query('SELECT id FROM grille_tarifaire WHERE id = $1', [b.grilleId])).rows[0];
      if (!grille) throw notFound('Grille');
      const billed = (
        await tx.query<{ fin: string | null }>(
          `SELECT max(periode_fin)::text AS fin FROM facture WHERE entreprise_id = $1 AND type = 'FACTURE' AND statut NOT IN ('BROUILLON','ANNULEE')`,
          [b.entrepriseId],
        )
      ).rows[0]!.fin;
      if (billed && b.dateDebut <= billed) throw unprocessable('PERIODE_FACTUREE', `Période déjà facturée jusqu’au ${billed} : le nouveau tarif doit commencer après`);
      const current = (
        await tx.query<{ id: string; date_debut: string; version: number }>(
          `SELECT id, date_debut::text, version FROM forfait WHERE entreprise_id = $1 AND statut = 'ACTIF' AND (date_fin IS NULL OR date_fin >= $2) ORDER BY date_debut DESC`,
          [b.entrepriseId, b.dateDebut],
        )
      ).rows;
      for (const c of current) {
        if (c.date_debut >= b.dateDebut) throw unprocessable('AVENANT', `Un forfait commence déjà le ${c.date_debut} : l’avenant doit démarrer après`);
        await tx.query(`UPDATE forfait SET date_fin = $2, updated_at = now() WHERE id = $1`, [c.id, addIsoDays(b.dateDebut, -1)]);
      }
      const version = ((await tx.query<{ v: number }>('SELECT coalesce(max(version), 0)::int AS v FROM forfait WHERE entreprise_id = $1', [b.entrepriseId])).rows[0]!.v ?? 0) + 1;
      const id = uuidv7();
      await tx.query(
        `INSERT INTO forfait (id, tenant_id, entreprise_id, grille_tarifaire_id, version, m2_inclus, prix_mensuel_cents, prix_m2_depassement_cents,
                              prestations_incluses, mode_surface, coefficient_degagement, m2_minimum, date_debut, engagement_mois, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id, user.tenantId, b.entrepriseId, b.grilleId, version, b.m2Inclus, b.prixMensuelCents, b.prixM2DepassementCents, JSON.stringify(b.prestationsIncluses),
          b.modeSurface, b.coefficientDegagement, b.m2Minimum, b.dateDebut, b.engagementMois ?? null, user.id,
        ],
      );
      await this.audit.record(tx, user, {
        action: current.length ? 'FORFAIT_AVENANT' : 'FORFAIT_CREE',
        objet: 'forfait',
        objetId: id,
        entrepriseId: b.entrepriseId,
        avant: current.length ? { forfaits: current.map((c) => c.id) } : undefined,
        apres: { ...b, version },
        motif: b.motif ?? null,
      });
      return { id, version };
    });
  }
}

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUTO_ISSUE_DELAY_DAYS,
  addIsoDays,
  computeMonthlyInvoice,
  contractPeriodInMonth,
  creditNoteLines,
  creditRatio,
  formatDocumentNumber,
  monthBounds,
  parisClock,
  partialCreditLines,
  totals,
  uuidv7,
  type InvoiceLine,
  type MonthlySurfaceMode,
} from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, DbContext, Tx } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { liveSurface } from '../client/client.controller.js';
import { StorageService } from '../storage/storage.service.js';
import { blPdf, invoicePdf, type Issuer } from './pdf.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** null = tâche automatique (pas d'utilisateur derrière l'action). */
export type Actor = AuthUser | null;

export const systemCtx = (tenantId: string): DbContext => ({ tenantId, role: 'SYSTEM' });

/** Nombre maximal de jours rattrapés d'un coup quand le service n'a pas tourné (au-delà : correction manuelle). */
const MAX_CATCH_UP_DAYS = 31;

interface ForfaitRow {
  id: string;
  entreprise_id: string;
  grille_tarifaire_id: string;
  m2_inclus: number;
  prix_mensuel_cents: number;
  prix_m2_depassement_cents: number;
  prestations_incluses: Record<string, number>;
  mode_surface: MonthlySurfaceMode;
  date_debut: string;
  date_fin: string | null;
}

interface FactureRow {
  id: string;
  tenant_id: string;
  numero: string | null;
  entreprise_id: string;
  forfait_id: string | null;
  type: 'FACTURE' | 'AVOIR';
  statut: string;
  periode_debut: string | null;
  periode_fin: string | null;
  m2_factures: number | null;
  total_ht_cents: number;
  tva_cents: number;
  total_ttc_cents: number;
  cle_pdf: string | null;
  empreinte_sha256: string | null;
  facture_origine_id: string | null;
  emise_le: Date | null;
  echeance: string | null;
  bon_de_commande: string | null;
  bloquee: boolean;
  motif: string | null;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Délai de paiement en jours lu dans les conditions du client (« 45 jours fin de mois » → 45), 30 par défaut. */
export function paymentDays(conditions: string | null | undefined): number {
  const m = /(\d{1,3})\s*j/i.exec(conditions ?? '');
  return m ? Math.min(120, Number(m[1])) : 30;
}

/**
 * Moteur de facturation (§6, FAC-02 à FAC-04) : instantanés quotidiens des m², brouillons mensuels,
 * émission avec numérotation continue, avoirs et PDF. Les règles de calcul sont dans @jamystock/domain (billing.ts).
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Journal d'audit ; `le` = instant métier de l'action (tâches planifiées, reprise d'historique), sinon maintenant. */
  private async audit(tx: Tx, tenantId: string, actor: Actor, e: { action: string; objet: string; objetId?: string | null; entrepriseId?: string | null; avant?: unknown; apres?: unknown; motif?: string | null; le?: Date }) {
    await tx.query(
      `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id, avant, apres, motif, horodatage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11, now()))`,
      [
        uuidv7(), tenantId, e.entrepriseId ?? null, actor?.id ?? null, e.action, e.objet, e.objetId ?? null,
        e.avant === undefined ? null : JSON.stringify(e.avant), e.apres === undefined ? null : JSON.stringify(e.apres), e.motif ?? null, e.le ?? null,
      ],
    );
  }

  // ===========================================================================================================
  // FAC-02 : instantanés quotidiens
  // ===========================================================================================================

  /**
   * Instantané d'un jour pour chaque client actif : une ligne entreprise (base de la facture) et une ligne par projet
   * (courbes). Calculé sur l'état du stock au moment de l'appel : à 23 h 59 pour le jour J, ou au rattrapage.
   * N'écrase pas un instantané existant.
   */
  async snapshotDay(tx: Tx, tenantId: string, date: string, source: 'AUTO' | 'RATTRAPAGE', entrepriseId?: string): Promise<number> {
    const clients = await tx.query<{ id: string }>(
      `SELECT id FROM entreprise WHERE statut = 'ACTIF' AND ($1::uuid IS NULL OR id = $1)
          AND (EXISTS (SELECT 1 FROM forfait f WHERE f.entreprise_id = entreprise.id AND f.statut IN ('ACTIF','TERMINE'))
               OR EXISTS (SELECT 1 FROM article a WHERE a.entreprise_id = entreprise.id))`,
      [entrepriseId ?? null],
    );
    let n = 0;
    for (const c of clients.rows) {
      const s = await liveSurface(tx, c.id, true);
      const motif = source === 'RATTRAPAGE' ? 'Rattrapage : le service ne tournait pas à 23 h 59, surface relevée à la reprise' : null;
      const r = await tx.query(
        `INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, date, m2_occupes, nb_articles, source, recalcul_motif)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [uuidv7(), tenantId, c.id, date, s.m2Occupes, s.nbArticles, source, motif],
      );
      n += r.rowCount ?? 0;
      for (const p of s.parProjet) {
        await tx.query(
          `INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, projet_id, date, m2_occupes, nb_articles, source, recalcul_motif)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [uuidv7(), tenantId, c.id, p.projetId, date, p.m2, p.nbArticles, source, motif],
        );
      }
    }
    return n;
  }

  /**
   * Garantit les instantanés jusqu'à la veille (rattrapage d'un service endormi) et celui du jour à partir de 23 h 59.
   * Ne remonte pas avant le dernier instantané existant, ni plus de 31 jours en arrière.
   */
  async ensureSnapshots(tx: Tx, tenantId: string, at: Date): Promise<number> {
    const clock = parisClock(at);
    const yesterday = addIsoDays(clock.date, -1);
    const last = (await tx.query<{ d: string | null }>(`SELECT max(date)::text AS d FROM instantane_occupation WHERE projet_id IS NULL AND depot_id IS NULL`)).rows[0]!.d;
    let from = last ? addIsoDays(last, 1) : yesterday;
    if (from < addIsoDays(yesterday, -(MAX_CATCH_UP_DAYS - 1))) from = addIsoDays(yesterday, -(MAX_CATCH_UP_DAYS - 1));
    let n = 0;
    for (let d = from; d <= yesterday; d = addIsoDays(d, 1)) n += await this.snapshotDay(tx, tenantId, d, 'RATTRAPAGE');
    if (clock.hour === 23 && clock.minute >= 59) n += await this.snapshotDay(tx, tenantId, clock.date, 'AUTO');
    return n;
  }

  /** Correction manuelle d'un instantané (FAC-02 « recalcul avec trace », RG-SEC-01 : motif + audit). */
  async correctSnapshot(user: AuthUser, p: { entrepriseId: string; du: string; au: string; m2: number; motif: string }) {
    if (p.au < p.du) throw unprocessable('PERIODE', 'La fin de période précède le début');
    if (p.du < addIsoDays(p.au, -92)) throw unprocessable('PERIODE', 'Corrigez au plus trois mois à la fois');
    return this.db.tx({ tenantId: user.tenantId, userId: user.id, role: user.role }, async (tx) => {
      const issued = await tx.query(
        `SELECT numero FROM facture WHERE entreprise_id = $1 AND type = 'FACTURE' AND statut NOT IN ('BROUILLON','ANNULEE')
            AND periode_debut <= $3 AND periode_fin >= $2 LIMIT 1`,
        [p.entrepriseId, p.du, p.au],
      );
      if (issued.rows[0]) {
        throw conflict('FACTURE_EMISE', `La facture ${issued.rows[0].numero} couvre déjà cette période : émettez un avoir avant de corriger les surfaces`);
      }
      const before = await tx.query<{ date: string; m2_occupes: number }>(
        `SELECT date::text, m2_occupes FROM instantane_occupation WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $2 AND $3 ORDER BY date`,
        [p.entrepriseId, p.du, p.au],
      );
      let n = 0;
      for (let d = p.du; d <= p.au; d = addIsoDays(d, 1)) {
        await tx.query(
          `INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, date, m2_occupes, nb_articles, source, recalcul_motif, calcule_le)
           VALUES ($1,$2,$3,$4,$5,0,'CORRECTION',$6, now())
           ON CONFLICT (entreprise_id, date, coalesce(projet_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(depot_id, '00000000-0000-0000-0000-000000000000'::uuid))
           DO UPDATE SET m2_occupes = EXCLUDED.m2_occupes, source = 'CORRECTION', recalcul_motif = EXCLUDED.recalcul_motif, calcule_le = now()`,
          [uuidv7(), user.tenantId, p.entrepriseId, d, p.m2, p.motif],
        );
        n++;
      }
      await this.audit(tx, user.tenantId, user, {
        action: 'INSTANTANE_CORRIGE',
        objet: 'instantane_occupation',
        entrepriseId: p.entrepriseId,
        avant: before.rows,
        apres: { du: p.du, au: p.au, m2: p.m2 },
        motif: p.motif,
      });
      return { jours: n };
    });
  }

  // ===========================================================================================================
  // FAC-03 : brouillons mensuels
  // ===========================================================================================================

  /**
   * ADM-02 : estimation de la prochaine facture, sans rien écrire. Mêmes règles que le brouillon du 1er : forfait au prorata,
   * dépassement sur la surface moyenne (ou le pic), prestations du mois. Les jours passés viennent des relevés de 23 h 59 ;
   * les jours restants sont projetés à la surface actuelle (« si votre stock ne change pas »).
   */
  async estimate(tx: Tx, entrepriseId: string, at: Date) {
    const today = parisClock(at).date;
    const month = today.slice(0, 7);
    const forfaits = await tx.query<ForfaitRow>(
      `SELECT f.id, f.entreprise_id, f.grille_tarifaire_id, f.m2_inclus, f.prix_mensuel_cents, f.prix_m2_depassement_cents,
              f.prestations_incluses, f.mode_surface, f.date_debut::text, f.date_fin::text
         FROM forfait f WHERE f.statut IN ('ACTIF','TERMINE') AND f.entreprise_id = $1 ORDER BY f.date_debut`,
      [entrepriseId],
    );
    const live = (await liveSurface(tx, entrepriseId, true)).m2Occupes;
    const out: ({ totalHtCents: number; tvaCents: number; totalTtcCents: number } & Record<string, unknown>)[] = [];
    for (const f of forfaits.rows) {
      const period = contractPeriodInMonth(month, f.date_debut, f.date_fin);
      if (!period || period.from > today) continue;
      const known = await tx.query<{ date: string; m2_occupes: number }>(
        `SELECT date::text, m2_occupes FROM instantane_occupation WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $2 AND $3 ORDER BY date`,
        [entrepriseId, period.from, period.to < today ? period.to : addIsoDays(today, -1)],
      );
      const projected = Math.max(0, period.days - known.rows.length);
      const daily = [...known.rows.map((r) => Number(r.m2_occupes)), ...Array.from({ length: projected }, () => live)];
      const services = await tx.query<{ code: string; libelle: string; quantite: number; unite: string; prix_unitaire_ht_cents: number; taux_tva: number; date_prestation: string }>(
        `SELECT code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, date_prestation::text FROM prestation_a_facturer
          WHERE entreprise_id = $1 AND facture_id IS NULL AND date_prestation <= $2 ORDER BY date_prestation, created_at`,
        [entrepriseId, period.to],
      );
      const draft = computeMonthlyInvoice({
        terms: {
          includedM2: f.m2_inclus,
          monthlyPriceCents: f.prix_mensuel_cents,
          overagePricePerM2Cents: f.prix_m2_depassement_cents,
          includedServices: f.prestations_incluses ?? {},
          vatRate: 20,
          surfaceMode: f.mode_surface,
        },
        dailyM2: daily,
        coveredDays: period.days,
        daysInMonth: monthBounds(month).days,
        services: services.rows.map((s) => ({
          code: s.code,
          label: `${s.libelle} du ${new Date(`${s.date_prestation}T12:00:00Z`).toLocaleDateString('fr-FR')}`,
          quantity: Number(s.quantite),
          unit: s.unite,
          unitPriceCents: s.prix_unitaire_ht_cents,
          vatRate: Number(s.taux_tva),
        })),
      });
      out.push({
        periodeDebut: period.from,
        periodeFin: period.to,
        m2Inclus: Number(f.m2_inclus),
        modeSurface: f.mode_surface,
        m2Factures: draft.billedM2,
        joursReleves: known.rows.length,
        joursProjetes: projected,
        lignes: draft.lines.map((l) => ({ type: l.type, libelle: l.label, quantite: l.quantity, unite: l.unit, prixUnitaireHtCents: l.unitPriceCents, totalHtCents: l.totalHtCents })),
        totalHtCents: draft.totalHtCents,
        tvaCents: draft.totalVatCents,
        totalTtcCents: draft.totalTtcCents,
      });
    }
    const sum = (k: 'totalHtCents' | 'tvaCents' | 'totalTtcCents') => out.reduce((s, x) => s + x[k], 0);
    return {
      mois: month,
      calculeLe: at.toISOString(),
      emissionPrevue: addIsoDays(monthBounds(month).end, 1 + AUTO_ISSUE_DELAY_DAYS),
      surfaceActuelle: live,
      factures: out,
      totalHtCents: sum('totalHtCents'),
      tvaCents: sum('tvaCents'),
      totalTtcCents: sum('totalTtcCents'),
    };
  }

  /**
   * Brouillons du mois pour chaque contrat qui le couvre (un avenant en cours de mois donne deux factures au prorata).
   * Un brouillon existant est recalculé ; une facture déjà émise n'est jamais touchée.
   */
  async generateDrafts(tx: Tx, tenantId: string, actor: Actor, month: string, at: Date, entrepriseId?: string) {
    const forfaits = await tx.query<ForfaitRow>(
      `SELECT f.id, f.entreprise_id, f.grille_tarifaire_id, f.m2_inclus, f.prix_mensuel_cents, f.prix_m2_depassement_cents,
              f.prestations_incluses, f.mode_surface, f.date_debut::text, f.date_fin::text
         FROM forfait f JOIN entreprise e ON e.id = f.entreprise_id
        WHERE f.statut IN ('ACTIF','TERMINE') AND ($1::uuid IS NULL OR f.entreprise_id = $1)
        ORDER BY e.nom, f.date_debut`,
      [entrepriseId ?? null],
    );
    const today = parisClock(at).date;
    const result = { crees: 0, recalcules: 0, ignores: 0, factures: [] as string[] };
    for (const f of forfaits.rows) {
      const period = contractPeriodInMonth(month, f.date_debut, f.date_fin);
      if (!period) continue;
      if (period.from > today) continue; // contrat pas encore commencé
      const existing = (
        await tx.query<{ id: string; statut: string }>(
          `SELECT id, statut FROM facture WHERE entreprise_id = $1 AND periode_debut = $2 AND type = 'FACTURE' AND statut <> 'ANNULEE' FOR UPDATE`,
          [f.entreprise_id, period.from],
        )
      ).rows[0];
      if (existing && existing.statut !== 'BROUILLON') {
        result.ignores++;
        continue;
      }
      if (existing) {
        await tx.query('UPDATE prestation_a_facturer SET facture_id = NULL WHERE facture_id = $1', [existing.id]);
        await tx.query('DELETE FROM ligne_facture WHERE facture_id = $1', [existing.id]);
      }

      const days = await tx.query<{ m2_occupes: number }>(
        `SELECT m2_occupes FROM instantane_occupation WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $2 AND $3 ORDER BY date`,
        [f.entreprise_id, period.from, period.to],
      );
      const daily = days.rows.length ? days.rows.map((r) => r.m2_occupes) : [(await liveSurface(tx, f.entreprise_id, true)).m2Occupes];
      const services = await tx.query<{ id: string; code: string; libelle: string; quantite: number; unite: string; prix_unitaire_ht_cents: number; taux_tva: number; date_prestation: string }>(
        `SELECT id, code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, date_prestation::text FROM prestation_a_facturer
          WHERE entreprise_id = $1 AND facture_id IS NULL AND date_prestation <= $2 ORDER BY date_prestation, created_at`,
        [f.entreprise_id, period.to],
      );
      const draft = computeMonthlyInvoice({
        terms: {
          includedM2: f.m2_inclus,
          monthlyPriceCents: f.prix_mensuel_cents,
          overagePricePerM2Cents: f.prix_m2_depassement_cents,
          includedServices: f.prestations_incluses ?? {},
          vatRate: 20,
          surfaceMode: f.mode_surface,
        },
        dailyM2: daily,
        coveredDays: period.days,
        daysInMonth: monthBounds(month).days,
        services: services.rows.map((s) => ({
          code: s.code,
          label: `${s.libelle} du ${new Date(`${s.date_prestation}T12:00:00Z`).toLocaleDateString('fr-FR')}`,
          quantity: s.quantite,
          unit: s.unite,
          unitPriceCents: s.prix_unitaire_ht_cents,
          vatRate: s.taux_tva,
          sourceId: s.id,
        })),
      });
      const emissionPrevue = addIsoDays(today, AUTO_ISSUE_DELAY_DAYS);
      let id = existing?.id;
      if (id) {
        await tx.query(
          `UPDATE facture SET forfait_id = $2, periode_fin = $3, m2_factures = $4, total_ht_cents = $5, tva_cents = $6, total_ttc_cents = $7, updated_at = now() WHERE id = $1`,
          [id, f.id, period.to, draft.billedM2, draft.totalHtCents, draft.totalVatCents, draft.totalTtcCents],
        );
        result.recalcules++;
      } else {
        id = uuidv7();
        await tx.query(
          `INSERT INTO facture (id, tenant_id, entreprise_id, forfait_id, type, periode_debut, periode_fin, statut, m2_factures,
                                total_ht_cents, tva_cents, total_ttc_cents, emission_prevue, created_by)
           VALUES ($1,$2,$3,$4,'FACTURE',$5,$6,'BROUILLON',$7,$8,$9,$10,$11,$12)`,
          [id, tenantId, f.entreprise_id, f.id, period.from, period.to, draft.billedM2, draft.totalHtCents, draft.totalVatCents, draft.totalTtcCents, emissionPrevue, actor?.id ?? null],
        );
        result.crees++;
      }
      await this.insertLines(tx, tenantId, id, draft.lines);
      // les prestations consommées par le quota inclus sont rattachées aussi : elles ne doivent pas resurgir le mois suivant
      if (services.rows.length) await tx.query('UPDATE prestation_a_facturer SET facture_id = $1 WHERE id = ANY($2)', [id, services.rows.map((s) => s.id)]);
      result.factures.push(id);
    }
    if (actor && (result.crees || result.recalcules)) {
      await this.audit(tx, tenantId, actor, { action: 'BROUILLONS_GENERES', objet: 'facture', apres: { mois: month, ...result, factures: undefined }, entrepriseId: entrepriseId ?? null, le: at });
    }
    return result;
  }

  private async insertLines(tx: Tx, tenantId: string, factureId: string, lines: InvoiceLine[], start = 0) {
    for (const [i, l] of lines.entries()) {
      await tx.query(
        `INSERT INTO ligne_facture (id, tenant_id, facture_id, type, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, total_ht_cents, source_id, ordre)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uuidv7(), tenantId, factureId, l.type, l.label, l.quantity, l.unit, l.unitPriceCents, l.vatRate, l.totalHtCents, l.sourceId ?? null, start + i],
      );
    }
  }

  private async lockDraft(tx: Tx, id: string): Promise<FactureRow> {
    const f = (await tx.query<FactureRow>('SELECT * FROM facture WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!f) throw notFound('Facture');
    if (f.statut !== 'BROUILLON') throw conflict('FACTURE_EMISE', 'Facture émise : elle ne se modifie plus (émettez un avoir)');
    return f;
  }

  private async refreshTotals(tx: Tx, id: string) {
    const lines = await tx.query<{ total_ht_cents: number; taux_tva: number }>('SELECT total_ht_cents, taux_tva FROM ligne_facture WHERE facture_id = $1', [id]);
    const t = totals(lines.rows.map((l) => ({ totalHtCents: l.total_ht_cents, vatRate: l.taux_tva })));
    await tx.query('UPDATE facture SET total_ht_cents = $2, tva_cents = $3, total_ttc_cents = $4, updated_at = now() WHERE id = $1', [id, t.totalHtCents, t.totalVatCents, t.totalTtcCents]);
  }

  /** Revue d'un brouillon : ligne ajoutée à la main (prestation ponctuelle, geste commercial), avec motif. */
  async addLine(tx: Tx, user: AuthUser, id: string, l: { libelle: string; quantite: number; unite: string; prixUnitaireHtCents: number; tauxTva: number; motif: string }) {
    const f = await this.lockDraft(tx, id);
    const n = (await tx.query<{ n: number }>('SELECT coalesce(max(ordre) + 1, 0)::int AS n FROM ligne_facture WHERE facture_id = $1', [id])).rows[0]!.n;
    const line: InvoiceLine = {
      type: 'PRESTATION',
      label: l.libelle,
      quantity: l.quantite,
      unit: l.unite,
      unitPriceCents: l.prixUnitaireHtCents,
      vatRate: l.tauxTva,
      totalHtCents: Math.round(l.quantite * l.prixUnitaireHtCents),
    };
    await this.insertLines(tx, user.tenantId, id, [line], n);
    await this.refreshTotals(tx, id);
    await this.audit(tx, user.tenantId, user, { action: 'LIGNE_AJOUTEE', objet: 'facture', objetId: id, entrepriseId: f.entreprise_id, apres: line, motif: l.motif });
  }

  async removeLine(tx: Tx, user: AuthUser, id: string, lineId: string, motif: string) {
    const f = await this.lockDraft(tx, id);
    const r = await tx.query('DELETE FROM ligne_facture WHERE id = $1 AND facture_id = $2 RETURNING libelle, total_ht_cents, source_id', [lineId, id]);
    if (!r.rowCount) throw notFound('Ligne');
    // une prestation retirée redevient facturable plus tard (ou jamais, si le motif l'explique)
    if (r.rows[0].source_id) await tx.query('UPDATE prestation_a_facturer SET facture_id = NULL WHERE id = $1 AND facture_id = $2', [r.rows[0].source_id, id]);
    await this.refreshTotals(tx, id);
    await this.audit(tx, user.tenantId, user, { action: 'LIGNE_RETIREE', objet: 'facture', objetId: id, entrepriseId: f.entreprise_id, avant: r.rows[0], motif });
  }

  async setBlocked(tx: Tx, user: AuthUser, id: string, bloquee: boolean, motif?: string, at = new Date()) {
    const f = await this.lockDraft(tx, id);
    if (bloquee && !motif?.trim()) throw unprocessable('MOTIF', 'Indiquez pourquoi la facture est bloquée');
    await tx.query('UPDATE facture SET bloquee = $2, motif_blocage = $3, updated_at = now() WHERE id = $1', [id, bloquee, bloquee ? motif!.trim() : null]);
    await this.audit(tx, user.tenantId, user, { action: bloquee ? 'FACTURE_BLOQUEE' : 'FACTURE_DEBLOQUEE', objet: 'facture', objetId: id, entrepriseId: f.entreprise_id, motif: motif ?? null, le: at });
  }

  // ===========================================================================================================
  // Émission (FAC-03) et avoirs (FAC-04)
  // ===========================================================================================================

  /** Émet un brouillon : numéro continu, échéance, PDF figé et son empreinte. */
  async issue(tx: Tx, tenantId: string, actor: Actor, id: string, at: Date) {
    const f = await this.lockDraft(tx, id);
    if (f.bloquee) throw conflict('FACTURE_BLOQUEE', `Facture bloquée : ${f.motif ?? 'débloquez-la avant de l’émettre'}`);
    const lines = await tx.query('SELECT 1 FROM ligne_facture WHERE facture_id = $1 LIMIT 1', [id]);
    if (!lines.rowCount) throw unprocessable('FACTURE_VIDE', 'Facture sans ligne');
    const year = Number(parisClock(at).date.slice(0, 4));
    const prefix = f.type === 'AVOIR' ? 'AV' : 'FA';
    const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [tenantId, prefix, year])).rows[0]!.n;
    const numero = formatDocumentNumber(prefix, year, seq);
    const ent = (
      await tx.query<{ conditions_paiement: string | null; bon_de_commande: string | null; email_facturation: string | null; prelevement: boolean }>(
        `SELECT conditions_paiement, bon_de_commande, email_facturation,
                (stripe_payment_method_id IS NOT NULL AND moyen_paiement IN ('CARTE','SEPA')) AS prelevement
           FROM entreprise WHERE id = $1`,
        [f.entreprise_id],
      )
    ).rows[0]!;
    const echeance = f.type === 'AVOIR' ? null : addIsoDays(parisClock(at).date, paymentDays(ent.conditions_paiement));
    // ADM-04 : le bon de commande du client est rappelé sur la facture
    const bonDeCommande = f.bon_de_commande ?? ent.bon_de_commande;
    const issued: FactureRow = { ...f, numero, emise_le: at, echeance, statut: 'EMISE', bon_de_commande: bonDeCommande };
    const pdf = await this.renderInvoice(tx, issued);
    const key = `${tenantId}/factures/${numero}.pdf`;
    await this.storage.put(key, pdf);
    await tx.query(
      `UPDATE facture SET numero = $2, statut = 'EMISE', emise_le = $3, echeance = $4, cle_pdf = $5, empreinte_sha256 = $6, bon_de_commande = $7, updated_at = now() WHERE id = $1`,
      [id, numero, at, echeance, key, sha256(pdf), bonDeCommande],
    );
    if (f.type === 'FACTURE') {
      // §6.3 : « facture émise » au contact facturation, à défaut aux administrateurs du compte client
      const vars = { factureId: id, numero, totalTtcCents: f.total_ttc_cents, echeance, prelevement: ent.prelevement };
      if (ent.email_facturation) await NotificationsService.enqueue(tx, tenantId, { modele: 'FACTURE_EMISE', adresse: ent.email_facturation, variables: vars });
      else {
        const admins = await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE entreprise_id = $1 AND role IN ('B2B_ADMIN','B2C') AND statut = 'ACTIF'`, [f.entreprise_id]);
        for (const a of admins.rows) await NotificationsService.enqueue(tx, tenantId, { modele: 'FACTURE_EMISE', destinataireId: a.id, variables: vars });
      }
    }
    if (f.forfait_id) {
      // une grille utilisée pour facturer ne se modifie plus en place (FAC-01 : nouvelle version)
      await tx.query('UPDATE grille_tarifaire SET utilisee = true WHERE id = (SELECT grille_tarifaire_id FROM forfait WHERE id = $1) AND NOT utilisee', [f.forfait_id]);
    }
    await this.audit(tx, tenantId, actor, { action: f.type === 'AVOIR' ? 'AVOIR_EMIS' : 'FACTURE_EMISE', objet: 'facture', objetId: id, entrepriseId: f.entreprise_id, apres: { numero, totalHtCents: f.total_ht_cents }, le: at });
    return { id, numero };
  }

  /** Émission automatique à J+2 des brouillons non bloqués (chaque facture dans sa propre transaction). */
  async autoIssue(tenantId: string, at: Date): Promise<string[]> {
    const today = parisClock(at).date;
    const due = await this.db.tx(systemCtx(tenantId), (tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM facture WHERE statut = 'BROUILLON' AND type = 'FACTURE' AND NOT bloquee AND emission_prevue <= $1 ORDER BY created_at`,
        [today],
      ),
    );
    const done: string[] = [];
    for (const r of due.rows) {
      try {
        const res = await this.db.tx(systemCtx(tenantId), (tx) => this.issue(tx, tenantId, null, r.id, at));
        done.push(res.numero);
      } catch (e) {
        console.warn(`Émission automatique impossible pour la facture ${r.id} : ${(e as Error).message}`);
      }
    }
    return done;
  }

  /** Avoir total ou partiel lié à la facture d'origine, émis immédiatement (FAC-04, RG-SEC-01). */
  async credit(tx: Tx, user: AuthUser, originId: string, p: { montantHtCents?: number; motif: string }, at: Date) {
    const o = (await tx.query<FactureRow>('SELECT * FROM facture WHERE id = $1 FOR UPDATE', [originId])).rows[0];
    if (!o) throw notFound('Facture');
    if (o.type !== 'FACTURE' || !['EMISE', 'PAYEE', 'EN_RETARD'].includes(o.statut)) throw conflict('STATUT', 'Seule une facture émise peut recevoir un avoir');
    const credited = (
      await tx.query<{ c: number }>(`SELECT coalesce(-sum(total_ht_cents), 0)::int AS c FROM facture WHERE facture_origine_id = $1 AND type = 'AVOIR' AND statut <> 'ANNULEE'`, [originId])
    ).rows[0]!.c;
    let ratio: number;
    try {
      ratio = creditRatio(o.total_ht_cents, credited, p.montantHtCents);
    } catch (e) {
      throw unprocessable('MONTANT_AVOIR', (e as Error).message);
    }
    const originLines = await tx.query<{ type: InvoiceLine['type']; libelle: string; quantite: number; unite: string; prix_unitaire_ht_cents: number; taux_tva: number; total_ht_cents: number }>(
      'SELECT type, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, total_ht_cents FROM ligne_facture WHERE facture_id = $1 ORDER BY ordre',
      [originId],
    );
    const asLines: InvoiceLine[] = originLines.rows.map((l) => ({
      type: l.type, label: l.libelle, quantity: l.quantite, unit: l.unite, unitPriceCents: l.prix_unitaire_ht_cents, vatRate: l.taux_tva, totalHtCents: l.total_ht_cents,
    }));
    const full = credited === 0 && ratio === 1;
    const lines = full ? creditNoteLines(asLines, 1) : partialCreditLines(asLines, Math.round(ratio * o.total_ht_cents), `Avoir partiel sur la facture ${o.numero} : ${p.motif}`);
    const t = totals(lines);
    const id = uuidv7();
    await tx.query(
      `INSERT INTO facture (id, tenant_id, entreprise_id, forfait_id, type, periode_debut, periode_fin, statut, total_ht_cents, tva_cents, total_ttc_cents,
                            facture_origine_id, motif, bon_de_commande, created_by)
       VALUES ($1,$2,$3,$4,'AVOIR',NULL,NULL,'BROUILLON',$5,$6,$7,$8,$9,$10,$11)`,
      [id, user.tenantId, o.entreprise_id, o.forfait_id, t.totalHtCents, t.totalVatCents, t.totalTtcCents, originId, p.motif, o.bon_de_commande, user.id],
    );
    await this.insertLines(tx, user.tenantId, id, lines);
    const res = await this.issue(tx, user.tenantId, user, id, at);
    // un avoir qui solde la facture l'annule : la période peut alors être refacturée correctement
    if (credited + Math.round(ratio * o.total_ht_cents) >= o.total_ht_cents) {
      await tx.query(`UPDATE facture SET statut = 'ANNULEE', updated_at = now() WHERE id = $1`, [originId]);
      await tx.query('UPDATE prestation_a_facturer SET facture_id = NULL WHERE facture_id = $1', [originId]);
    }
    await this.audit(tx, user.tenantId, user, {
      action: 'AVOIR_CREE',
      objet: 'facture',
      objetId: originId,
      entrepriseId: o.entreprise_id,
      apres: { avoir: res.numero, montantHtCents: -t.totalHtCents, total: full },
      motif: p.motif,
      le: at,
    });
    return res;
  }

  /** Paiement reçu (virement, chèque) : pointage manuel en attendant le rapprochement automatique (FAC-05). */
  async markPaid(tx: Tx, user: AuthUser, id: string, p: { date: string; moyen: string; reference?: string }, at = new Date()) {
    const f = (await tx.query<FactureRow>('SELECT * FROM facture WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!f) throw notFound('Facture');
    if (f.type !== 'FACTURE' || !['EMISE', 'EN_RETARD'].includes(f.statut)) throw conflict('STATUT', 'Seule une facture émise et non réglée peut être marquée payée');
    await tx.query('INSERT INTO paiement (id, tenant_id, facture_id, moyen, montant_cents, date, reference_psp) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      uuidv7(), user.tenantId, id, p.moyen, f.total_ttc_cents, p.date, p.reference ?? null,
    ]);
    await tx.query(`UPDATE facture SET statut = 'PAYEE', paye_le = $2, updated_at = now() WHERE id = $1`, [id, p.date]);
    await this.audit(tx, user.tenantId, user, { action: 'FACTURE_PAYEE', objet: 'facture', objetId: id, entrepriseId: f.entreprise_id, apres: p, le: at });
  }

  // ===========================================================================================================
  // PDF
  // ===========================================================================================================

  private async issuer(tx: Tx): Promise<Issuer> {
    const o = (await tx.query<{ raison_sociale: string; siret: string | null; parametres: Record<string, unknown> }>('SELECT raison_sociale, siret, parametres FROM organisation WHERE id = app_tenant()')).rows[0];
    const f = (o?.parametres?.facturation ?? {}) as Partial<Issuer>;
    return { raisonSociale: o?.raison_sociale ?? 'JAMYSTOCK', siret: o?.siret ?? f.siret, adresse: f.adresse, tva: f.tva, iban: f.iban, email: f.email };
  }

  private async renderInvoice(tx: Tx, f: FactureRow): Promise<Buffer> {
    const e = (
      await tx.query<{ nom: string; type: 'B2B' | 'B2C'; siret: string | null; tva_intracom: string | null; adresse_facturation: { libelle?: string } | null; conditions_paiement: string | null }>(
        'SELECT nom, type, siret, tva_intracom, adresse_facturation, conditions_paiement FROM entreprise WHERE id = $1',
        [f.entreprise_id],
      )
    ).rows[0]!;
    const lines = await tx.query<{ libelle: string; quantite: number; unite: string; prix_unitaire_ht_cents: number; taux_tva: number; total_ht_cents: number }>(
      'SELECT libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, total_ht_cents FROM ligne_facture WHERE facture_id = $1 ORDER BY ordre',
      [f.id],
    );
    const origine = f.facture_origine_id
      ? (await tx.query<{ numero: string; emise_le: Date }>('SELECT numero, emise_le FROM facture WHERE id = $1', [f.facture_origine_id])).rows[0]
      : undefined;
    return invoicePdf({
      issuer: await this.issuer(tx),
      type: f.type,
      numero: f.numero!,
      emiseLe: new Date(f.emise_le!),
      echeance: f.echeance,
      periodeDebut: f.periode_debut,
      periodeFin: f.periode_fin,
      m2Factures: f.m2_factures,
      client: { nom: e.nom, type: e.type, adresse: e.adresse_facturation?.libelle, siret: e.siret, tva: e.tva_intracom },
      conditionsPaiement: e.conditions_paiement,
      bonDeCommande: f.bon_de_commande,
      origine: origine ? { numero: origine.numero, emiseLe: origine.emise_le } : null,
      motif: f.motif,
      lignes: lines.rows.map((l) => ({ libelle: l.libelle, quantite: l.quantite, unite: l.unite, prixUnitaireHtCents: l.prix_unitaire_ht_cents, tauxTva: l.taux_tva, totalHtCents: l.total_ht_cents })),
      totalHtCents: f.total_ht_cents,
      tvaCents: f.tva_cents,
      totalTtcCents: f.total_ttc_cents,
    });
  }

  /**
   * PDF d'une facture émise. Sur un hébergement sans disque persistant, le fichier est régénéré à l'identique
   * depuis la base (lignes et dates figées) ; l'empreinte enregistrée à l'émission permet de le vérifier.
   */
  async invoiceFile(tx: Tx, id: string): Promise<{ name: string; data: Buffer; date: Date }> {
    const f = (await tx.query<FactureRow>('SELECT * FROM facture WHERE id = $1', [id])).rows[0];
    if (!f) throw notFound('Facture');
    if (f.statut === 'BROUILLON' || !f.numero) throw conflict('BROUILLON', 'Brouillon : le PDF est produit à l’émission');
    let data: Buffer | undefined;
    if (f.cle_pdf) data = await this.storage.get(f.cle_pdf).catch(() => undefined);
    if (!data) {
      data = await this.renderInvoice(tx, f);
      if (f.cle_pdf) await this.storage.put(f.cle_pdf, data).catch(() => undefined);
    }
    return { name: `${f.numero}.pdf`, data, date: new Date(f.emise_le!) };
  }

  /** PDF d'un BL signé, produit à la première demande puis figé (empreinte enregistrée). */
  async blFile(tx: Tx, id: string): Promise<{ name: string; data: Buffer; date: Date }> {
    const bl = (
      await tx.query<{
        id: string; tenant_id: string; numero: string; type: 'LIVRAISON' | 'RETRAIT' | 'REFUS' | 'ENLEVEMENT'; commande_id: string; signataire_nom: string | null;
        signataire_qualite: string | null; signature_svg: string | null; signe_le: Date | null; recu_le: Date; latitude: number | null; longitude: number | null;
        precision_m: number | null; empreinte_sha256: string | null; cle_pdf: string | null; empreinte_pdf_sha256: string | null; statut: string;
        cnum: string | null; ctype: string; adresse: { libelle?: string } | null; client: string; projet: string | null;
      }>(
        `SELECT b.*, c.numero AS cnum, c.type AS ctype, c.adresse, e.nom AS client, p.nom AS projet
           FROM bon_de_livraison b JOIN commande c ON c.id = b.commande_id JOIN entreprise e ON e.id = b.entreprise_id
           LEFT JOIN projet p ON p.id = c.projet_id WHERE b.id = $1`,
        [id],
      )
    ).rows[0];
    if (!bl) throw notFound('BL');
    if (bl.statut !== 'SIGNE') throw conflict('BL_NON_SIGNE', 'BL non signé');
    if (bl.cle_pdf) {
      const stored = await this.storage.get(bl.cle_pdf).catch(() => undefined);
      if (stored) return { name: `${bl.numero}.pdf`, data: stored, date: new Date(bl.signe_le ?? bl.recu_le) };
    }
    const articles =
      bl.type === 'ENLEVEMENT'
        ? (await tx.query<{ libelle: string; qr: string }>(`SELECT libelle, qr_code AS qr FROM article WHERE commande_collecte_id = $1 ORDER BY libelle`, [bl.commande_id])).rows.map((a) => ({
            ...a,
            etat: 'ENLEVE' as const,
          }))
        : (
            await tx.query<{ libelle: string; qr: string; statut_ligne: string }>(
              `SELECT a.libelle, a.qr_code AS qr, l.statut_ligne FROM ligne_commande l JOIN article a ON a.id = l.article_id
                WHERE l.commande_id = $1 AND l.statut_ligne IN ('LIVREE','REFUSEE') ORDER BY a.libelle`,
              [bl.commande_id],
            )
          ).rows.map((a) => ({ libelle: a.libelle, qr: a.qr, etat: a.statut_ligne === 'REFUSEE' ? ('REFUSE' as const) : ('LIVRE' as const) }));
    const reserves = await tx.query<{ article: string; type: string; commentaire: string | null }>(
      `SELECT coalesce(a.libelle, 'Livraison') AS article, r.type, r.commentaire FROM reserve r LEFT JOIN article a ON a.id = r.article_id WHERE r.bl_id = $1`,
      [id],
    );
    const signeLe = new Date(bl.signe_le ?? bl.recu_le);
    const data = await blPdf({
      issuer: await this.issuer(tx),
      numero: bl.numero,
      type: bl.type,
      commande: bl.cnum,
      client: bl.client,
      projet: bl.projet,
      adresse: bl.ctype === 'RETRAIT' ? null : (bl.adresse?.libelle ?? null),
      signeLe,
      signataire: { nom: bl.signataire_nom, qualite: bl.signataire_qualite },
      gps: bl.latitude != null && bl.longitude != null ? { lat: bl.latitude, lng: bl.longitude, precision: bl.precision_m } : null,
      articles,
      reserves: reserves.rows,
      signatureSvg: bl.signature_svg,
      empreinte: bl.empreinte_sha256,
    });
    const key = `${bl.tenant_id}/bl/${bl.numero}.pdf`;
    await this.storage.put(key, data);
    if (!bl.cle_pdf) await tx.query('UPDATE bon_de_livraison SET cle_pdf = $2, empreinte_pdf_sha256 = $3 WHERE id = $1 AND cle_pdf IS NULL', [id, key, sha256(data)]);
    return { name: `${bl.numero}.pdf`, data, date: signeLe };
  }
}

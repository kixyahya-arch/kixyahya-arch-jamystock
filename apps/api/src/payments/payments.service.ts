import { Inject, Injectable } from '@nestjs/common';
import { parisClock, uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { BusinessError, conflict, notFound } from '../common/errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { StripeClient, StripeError, type StripeEvent } from './stripe.js';

export type PaymentKind = 'CARTE' | 'SEPA';
const STRIPE_TYPE: Record<PaymentKind, string> = { CARTE: 'card', SEPA: 'sepa_debit' };

interface EntrepriseRow {
  id: string;
  nom: string;
  type: 'B2B' | 'B2C';
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  moyen_paiement: 'CARTE' | 'SEPA' | 'VIREMENT' | null;
  email_facturation: string | null;
}

interface PaymentMethod {
  id: string;
  type: string;
  card?: { brand: string; last4: string; exp_month: number; exp_year: number };
  sepa_debit?: { last4: string; bank_code?: string; country?: string };
}

const sys = (tenantId: string) => ({ tenantId, role: 'SYSTEM' as const });

/**
 * ADM-04 : moyens de paiement et règlement des factures avec Stripe.
 *  - enregistrement d'une carte (B2C, obligatoire) ou d'un mandat SEPA (B2B) via une page Stripe Checkout « setup » ;
 *  - prélèvement automatique des factures émises sur le moyen enregistré ;
 *  - paiement en ligne d'une facture à l'unité (Checkout « payment ») ;
 *  - rapprochement par webhook (paiement reçu, paiement refusé), rejouable sans double comptage.
 * Aucune donnée de carte ne transite par JAMYSTOCK : seuls la marque, les 4 derniers chiffres et l'expiration sont gardés.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  get enabled(): boolean {
    return !!this.config.stripe.secretKey;
  }

  private stripe(): StripeClient {
    if (!this.config.stripe.secretKey) throw new BusinessError(503, 'STRIPE_NON_CONFIGURE', 'Le paiement en ligne n’est pas encore activé : contactez JAMYSTOCK pour régler par virement.');
    return new StripeClient(this.config.stripe.secretKey, this.config.stripe.apiBase);
  }

  private async company(tenantId: string, id: string): Promise<EntrepriseRow> {
    const r = await this.db.tx(sys(tenantId), (tx) =>
      tx.query<EntrepriseRow>(
        'SELECT id, nom, type, stripe_customer_id, stripe_payment_method_id, moyen_paiement, email_facturation FROM entreprise WHERE id = $1',
        [id],
      ),
    );
    if (!r.rows[0]) throw notFound('Entreprise');
    return r.rows[0];
  }

  /** Client Stripe de l'entreprise, créé à la première utilisation. */
  private async customer(tenantId: string, e: EntrepriseRow, email: string | null): Promise<string> {
    if (e.stripe_customer_id) return e.stripe_customer_id;
    const c = await this.stripe().request<{ id: string }>(
      'POST',
      '/customers',
      { name: e.nom, email: e.email_facturation ?? email ?? undefined, metadata: { entreprise_id: e.id, tenant_id: tenantId } },
      `customer-${e.id}`,
    );
    await this.db.tx(sys(tenantId), (tx) => tx.query('UPDATE entreprise SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [e.id, c.id]));
    return c.id;
  }

  /** Page Stripe pour enregistrer une carte ou un mandat SEPA ; renvoie son adresse. */
  async setupSession(tenantId: string, entrepriseId: string, kind: PaymentKind, email: string | null): Promise<{ url: string }> {
    const e = await this.company(tenantId, entrepriseId);
    if (e.type === 'B2C' && kind !== 'CARTE') throw new BusinessError(422, 'MOYEN_REFUSE', 'Pour un particulier, le paiement se fait par carte bancaire');
    const customer = await this.customer(tenantId, e, email);
    const s = await this.stripe().request<{ url: string }>('POST', '/checkout/sessions', {
      mode: 'setup',
      customer,
      currency: 'eur',
      payment_method_types: [STRIPE_TYPE[kind]],
      success_url: `${this.config.publicUrl}/#/compte?paiement=enregistre`,
      cancel_url: `${this.config.publicUrl}/#/compte?paiement=annule`,
      metadata: { entreprise_id: e.id, tenant_id: tenantId, kind },
      setup_intent_data: { metadata: { entreprise_id: e.id, tenant_id: tenantId } },
    });
    return { url: s.url };
  }

  /** Paiement en ligne d'une facture émise (carte, ou SEPA pour un professionnel). */
  async payInvoiceSession(tenantId: string, entrepriseId: string, factureId: string, email: string | null): Promise<{ url: string }> {
    const e = await this.company(tenantId, entrepriseId);
    const f = (
      await this.db.tx(sys(tenantId), (tx) =>
        tx.query<{ id: string; numero: string; statut: string; type: string; total_ttc_cents: number }>(
          'SELECT id, numero, statut, type, total_ttc_cents FROM facture WHERE id = $1 AND entreprise_id = $2',
          [factureId, entrepriseId],
        ),
      )
    ).rows[0];
    if (!f) throw notFound('Facture');
    if (f.type !== 'FACTURE' || !['EMISE', 'EN_RETARD'].includes(f.statut)) throw conflict('STATUT', 'Cette facture n’est pas à régler');
    const customer = await this.customer(tenantId, e, email);
    const meta = { facture_id: f.id, entreprise_id: e.id, tenant_id: tenantId };
    const s = await this.stripe().request<{ url: string }>('POST', '/checkout/sessions', {
      mode: 'payment',
      customer,
      payment_method_types: e.type === 'B2B' ? ['card', 'sepa_debit'] : ['card'],
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: f.total_ttc_cents, product_data: { name: `Facture ${f.numero}` } } }],
      success_url: `${this.config.publicUrl}/#/documents?paiement=ok`,
      cancel_url: `${this.config.publicUrl}/#/documents`,
      metadata: meta,
      payment_intent_data: { metadata: meta, description: `Facture ${f.numero}` },
    });
    return { url: s.url };
  }

  /**
   * Prélèvement automatique des factures émises dont le client a un moyen enregistré (carte ou SEPA).
   * Une seule tentative automatique par facture ; la clé d'idempotence empêche un double débit si la passe est rejouée.
   */
  async collectDue(tenantId: string): Promise<{ tentes: number; refuses: number }> {
    if (!this.enabled) return { tentes: 0, refuses: 0 };
    const due = await this.db.tx(sys(tenantId), (tx) =>
      tx.query<{ id: string; numero: string; total_ttc_cents: number; entreprise_id: string; customer: string; pm: string; moyen: PaymentKind }>(
        `SELECT f.id, f.numero, f.total_ttc_cents, f.entreprise_id, e.stripe_customer_id AS customer, e.stripe_payment_method_id AS pm, e.moyen_paiement AS moyen
           FROM facture f JOIN entreprise e ON e.id = f.entreprise_id
          WHERE f.type = 'FACTURE' AND f.statut IN ('EMISE','EN_RETARD') AND f.prelevement_le IS NULL AND f.total_ttc_cents > 0
            AND e.moyen_paiement IN ('CARTE','SEPA') AND e.stripe_payment_method_id IS NOT NULL AND e.stripe_customer_id IS NOT NULL
          ORDER BY f.emise_le LIMIT 50`,
      ),
    );
    let refuses = 0;
    for (const f of due.rows) {
      let ref: string | null = null;
      let erreur: string | null = null;
      try {
        const pi = await this.stripe().request<{ id: string; status: string }>(
          'POST',
          '/payment_intents',
          {
            amount: f.total_ttc_cents,
            currency: 'eur',
            customer: f.customer,
            payment_method: f.pm,
            payment_method_types: [STRIPE_TYPE[f.moyen]],
            off_session: true,
            confirm: true,
            description: `Facture ${f.numero}`,
            metadata: { facture_id: f.id, entreprise_id: f.entreprise_id, tenant_id: tenantId },
          },
          `prelevement-${f.id}`,
        );
        ref = pi.id;
      } catch (e) {
        if (!(e instanceof StripeError)) throw e;
        ref = e.body.error?.payment_intent?.id ?? null;
        erreur = e.message;
        refuses++;
      }
      await this.db.tx(sys(tenantId), async (tx) => {
        await tx.query('UPDATE facture SET prelevement_le = now(), prelevement_ref = $2, prelevement_erreur = $3 WHERE id = $1', [f.id, ref, erreur]);
        if (erreur) await this.notifyFailure(tx, tenantId, f.id, erreur);
      });
    }
    return { tentes: due.rows.length, refuses };
  }

  // ===========================================================================================================
  // Webhook
  // ===========================================================================================================

  async handleEvent(event: StripeEvent): Promise<{ traite: boolean }> {
    const obj = event.data.object;
    const tenantId = obj.metadata?.tenant_id ?? this.config.defaultTenantId;
    if (!tenantId) return { traite: false };
    const fresh = await this.db.tx(sys(tenantId), (tx) =>
      tx.query('INSERT INTO stripe_evenement (id, tenant_id, type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [event.id, tenantId, event.type]),
    );
    if (!fresh.rowCount) return { traite: false }; // déjà traité (Stripe rejoue les webhooks)
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          if (obj.mode === 'setup' && typeof obj.setup_intent === 'string') await this.onSetupCompleted(tenantId, obj.metadata?.entreprise_id, obj.setup_intent);
          break;
        case 'payment_intent.succeeded':
          if (obj.metadata?.facture_id) await this.onPaid(tenantId, obj.metadata.facture_id, obj as unknown as { id: string; amount_received: number; payment_method: string | null });
          break;
        case 'payment_intent.payment_failed':
          if (obj.metadata?.facture_id) {
            const err = (obj.last_payment_error as { message?: string } | undefined)?.message ?? 'Paiement refusé';
            await this.db.tx(sys(tenantId), (tx) => this.notifyFailure(tx, tenantId, obj.metadata!.facture_id!, err));
          }
          break;
        default:
          break;
      }
    } catch (e) {
      // en cas d'erreur, on libère l'événement pour que Stripe puisse le rejouer
      await this.db.tx(sys(tenantId), (tx) => tx.query('DELETE FROM stripe_evenement WHERE id = $1', [event.id]));
      throw e;
    }
    return { traite: true };
  }

  private async onSetupCompleted(tenantId: string, entrepriseId: string | undefined, setupIntentId: string) {
    if (!entrepriseId) return;
    const si = await this.stripe().request<{ payment_method: PaymentMethod | null }>('GET', `/setup_intents/${setupIntentId}`, { expand: ['payment_method'] });
    const pm = si.payment_method;
    if (!pm) return;
    const kind: PaymentKind = pm.type === 'sepa_debit' ? 'SEPA' : 'CARTE';
    const detail =
      kind === 'CARTE' && pm.card
        ? { type: 'CARTE', marque: pm.card.brand, derniers4: pm.card.last4, expire: `${String(pm.card.exp_month).padStart(2, '0')}/${pm.card.exp_year}` }
        : { type: 'SEPA', derniers4: pm.sepa_debit?.last4 ?? '', pays: pm.sepa_debit?.country ?? null };
    await this.db.tx(sys(tenantId), async (tx) => {
      const before = (await tx.query<{ moyen_paiement: string | null; moyen_paiement_detail: unknown }>('SELECT moyen_paiement, moyen_paiement_detail FROM entreprise WHERE id = $1', [entrepriseId])).rows[0];
      await tx.query('UPDATE entreprise SET stripe_payment_method_id = $2, moyen_paiement = $3, moyen_paiement_detail = $4, updated_at = now() WHERE id = $1', [entrepriseId, pm.id, kind, JSON.stringify(detail)]);
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, action, objet, objet_id, avant, apres) VALUES ($1,$2,$3,'MOYEN_PAIEMENT_ENREGISTRE','entreprise',$3,$4,$5)`,
        [uuidv7(), tenantId, entrepriseId, JSON.stringify(before ?? null), JSON.stringify(detail)],
      );
    });
  }

  private async onPaid(tenantId: string, factureId: string, pi: { id: string; amount_received: number; payment_method: string | null }) {
    let moyen = 'CB';
    if (pi.payment_method) {
      const pm = await this.stripe().request<PaymentMethod>('GET', `/payment_methods/${pi.payment_method}`).catch(() => null);
      if (pm?.type === 'sepa_debit') moyen = 'SEPA';
    }
    await this.db.tx(sys(tenantId), async (tx) => {
      const f = (await tx.query<{ id: string; numero: string; statut: string; entreprise_id: string }>('SELECT id, numero, statut, entreprise_id FROM facture WHERE id = $1 FOR UPDATE', [factureId])).rows[0];
      if (!f) return;
      const today = parisClock(new Date()).date;
      const ins = await tx.query(
        `INSERT INTO paiement (id, tenant_id, facture_id, moyen, montant_cents, date, reference_psp) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [uuidv7(), tenantId, f.id, moyen, pi.amount_received, today, pi.id],
      );
      if (!ins.rowCount) return;
      if (['EMISE', 'EN_RETARD'].includes(f.statut)) {
        await tx.query(`UPDATE facture SET statut = 'PAYEE', paye_le = $2, prelevement_erreur = NULL, updated_at = now() WHERE id = $1`, [f.id, today]);
      }
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, action, objet, objet_id, apres) VALUES ($1,$2,$3,'FACTURE_PAYEE','facture',$4,$5)`,
        [uuidv7(), tenantId, f.entreprise_id, f.id, JSON.stringify({ moyen, montantCents: pi.amount_received, reference: pi.id, source: 'stripe' })],
      );
      await this.notifyContacts(tx, tenantId, f.entreprise_id, 'PAIEMENT_RECU', { factureId: f.id, numero: f.numero, montantCents: pi.amount_received });
    });
  }

  /** Paiement refusé : une seule alerte par motif (le refus synchrone et son webhook ne doublonnent pas). */
  private async notifyFailure(tx: Tx, tenantId: string, factureId: string, erreur: string) {
    const f = (
      await tx.query<{ numero: string; entreprise_id: string; total_ttc_cents: number; statut: string }>(
        'SELECT numero, entreprise_id, total_ttc_cents, statut FROM facture WHERE id = $1',
        [factureId],
      )
    ).rows[0];
    if (!f || f.statut === 'PAYEE') return;
    const already = await tx.query(
      `SELECT 1 FROM notification WHERE modele = 'PAIEMENT_ECHOUE' AND variables->>'factureId' = $1 AND variables->>'raison' = $2 AND created_at > now() - interval '1 day'`,
      [factureId, erreur],
    );
    await tx.query('UPDATE facture SET prelevement_erreur = $2 WHERE id = $1', [factureId, erreur]);
    if (already.rowCount) return;
    await this.notifyContacts(tx, tenantId, f.entreprise_id, 'PAIEMENT_ECHOUE', { factureId, numero: f.numero, totalTtcCents: f.total_ttc_cents, raison: erreur });
  }

  private async notifyContacts(tx: Tx, tenantId: string, entrepriseId: string, modele: string, variables: Record<string, unknown>) {
    const e = (await tx.query<{ email_facturation: string | null }>('SELECT email_facturation FROM entreprise WHERE id = $1', [entrepriseId])).rows[0];
    if (e?.email_facturation) return NotificationsService.enqueue(tx, tenantId, { modele, adresse: e.email_facturation, variables });
    const admins = await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE entreprise_id = $1 AND role IN ('B2B_ADMIN','B2C') AND statut = 'ACTIF'`, [entrepriseId]);
    for (const a of admins.rows) await NotificationsService.enqueue(tx, tenantId, { modele, destinataireId: a.id, variables });
  }
}

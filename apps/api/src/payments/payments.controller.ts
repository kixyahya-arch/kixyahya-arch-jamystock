import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { isValidFrenchVat, isValidSiret, normalizeSiret, uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import { ctxOf } from '../common/context.js';
import { BusinessError, forbidden, unprocessable } from '../common/errors.js';
import { PaymentsService } from './payments.service.js';
import { verifyWebhook } from './stripe.js';
import { BillingService } from '../billing/billing.service.js';

const BillingBody = z.object({
  adresseFacturation: z.string().trim().max(300).nullable().optional(),
  emailFacturation: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('').transform(() => null)),
  bonDeCommande: z.string().trim().max(60).nullable().optional(),
  siret: z.string().trim().max(20).nullable().optional(),
  tvaIntracom: z.string().trim().max(20).nullable().optional(),
  moyenPaiement: z.enum(['CARTE', 'SEPA', 'VIREMENT']).optional(),
});

/**
 * ADM-04 : informations de facturation et moyen de paiement du client, paiement en ligne des factures,
 * et réception des webhooks Stripe.
 */
@Controller()
export class PaymentsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  /** Le titulaire du compte (B2B Admin ou particulier) gère la facturation ; un utilisateur B2B n'y a pas accès. */
  private holder(user: AuthUser) {
    if (!['B2B_ADMIN', 'B2C'].includes(user.role) || !user.entrepriseId) throw forbidden('Réservé à l’administrateur du compte');
  }

  @Get('me/billing')
  @RequirePermission('billing.read')
  info(@CurrentUser() user: AuthUser) {
    this.holder(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = (
        await tx.query<{ type: 'B2B' | 'B2C'; adresse_facturation: { libelle?: string } | null; moyen_paiement: string | null; [k: string]: unknown }>(
          `SELECT nom, type, siret, tva_intracom AS "tvaIntracom", adresse_facturation, email_facturation AS "emailFacturation",
                  bon_de_commande AS "bonDeCommande", moyen_paiement, moyen_paiement_detail AS "moyenDetail", conditions_paiement AS "conditionsPaiement"
             FROM entreprise WHERE id = $1`,
          [user.entrepriseId],
        )
      ).rows[0]!;
      const org = (await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (s) => s.query<{ raison_sociale: string; parametres: { facturation?: { iban?: string; bic?: string } } }>('SELECT raison_sociale, parametres FROM organisation WHERE id = $1', [user.tenantId]))).rows[0];
      const { adresse_facturation, moyen_paiement, ...rest } = e;
      return {
        ...rest,
        adresseFacturation: adresse_facturation?.libelle ?? null,
        moyenPaiement: moyen_paiement,
        paiementEnLigne: this.payments.enabled,
        // B2C : carte obligatoire ; B2B : SEPA ou virement sur facture
        moyensProposes: e.type === 'B2C' ? ['CARTE'] : ['SEPA', 'VIREMENT'],
        virement: org?.parametres?.facturation?.iban ? { titulaire: org.raison_sociale, iban: org.parametres.facturation.iban, bic: org.parametres.facturation.bic ?? null } : null,
      };
    });
  }

  /** ADM-02 : estimation de la prochaine facture (mois en cours), recalculée à chaque consultation sur les relevés de la nuit. */
  @Get('me/billing/estimate')
  @RequirePermission('billing.read')
  estimate(@CurrentUser() user: AuthUser) {
    this.holder(user);
    return this.db.tx(ctxOf(user), (tx) => this.billing.estimate(tx, user.entrepriseId!, new Date()));
  }

  @Put('me/billing')
  @RequirePermission('billing.read')
  update(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.holder(user);
    const b = BillingBody.parse(body);
    if (b.siret && !isValidSiret(b.siret)) throw unprocessable('SIRET_INVALIDE', 'Numéro SIRET invalide');
    if (b.tvaIntracom && !isValidFrenchVat(b.tvaIntracom.replace(/\s/g, '').toUpperCase())) throw unprocessable('TVA_INVALIDE', 'Numéro de TVA intracommunautaire invalide');
    // l'entreprise ne s'écrit qu'en rôle système (RLS) : les contrôles de droits sont faits ici
    return this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      const e = (await tx.query<{ type: 'B2B' | 'B2C'; moyen_paiement: string | null; moyen_paiement_detail: { type?: string } | null; [k: string]: unknown }>('SELECT * FROM entreprise WHERE id = $1 FOR UPDATE', [user.entrepriseId])).rows[0]!;
      if (b.moyenPaiement && b.moyenPaiement !== e.moyen_paiement) {
        if (b.moyenPaiement === 'VIREMENT' && e.type === 'B2C') throw unprocessable('MOYEN_REFUSE', 'Pour un particulier, le paiement se fait par carte bancaire');
        if (b.moyenPaiement !== 'VIREMENT' && e.moyen_paiement_detail?.type !== b.moyenPaiement) {
          throw unprocessable('MOYEN_ABSENT', b.moyenPaiement === 'CARTE' ? 'Enregistrez d’abord une carte' : 'Enregistrez d’abord un mandat de prélèvement SEPA');
        }
      }
      const set: Record<string, unknown> = {};
      if (b.adresseFacturation !== undefined) set.adresse_facturation = b.adresseFacturation ? JSON.stringify({ libelle: b.adresseFacturation }) : null;
      if (b.emailFacturation !== undefined) set.email_facturation = b.emailFacturation;
      if (b.bonDeCommande !== undefined) set.bon_de_commande = b.bonDeCommande || null;
      if (b.siret !== undefined) set.siret = b.siret ? normalizeSiret(b.siret) : null;
      if (b.tvaIntracom !== undefined) set.tva_intracom = b.tvaIntracom ? b.tvaIntracom.replace(/\s/g, '').toUpperCase() : null;
      if (b.moyenPaiement) set.moyen_paiement = b.moyenPaiement;
      const keys = Object.keys(set);
      if (!keys.length) return { ok: true };
      await tx.query(`UPDATE entreprise SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [user.entrepriseId, ...keys.map((k) => set[k])]);
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id, avant, apres) VALUES ($1,$2,$3,$4,'FACTURATION_MODIFIEE','entreprise',$3,$5,$6)`,
        [uuidv7(), user.tenantId, user.entrepriseId, user.id, JSON.stringify(Object.fromEntries(keys.map((k) => [k, e[k] ?? null]))), JSON.stringify(set)],
      );
      return { ok: true };
    });
  }

  @Post('me/billing/payment-method')
  @HttpCode(200)
  @RequirePermission('billing.read')
  async paymentMethod(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.holder(user);
    const b = z.object({ type: z.enum(['CARTE', 'SEPA']) }).parse(body);
    return this.payments.setupSession(user.tenantId, user.entrepriseId!, b.type, await this.email(user));
  }

  @Post('me/invoices/:id/pay')
  @HttpCode(200)
  @RequirePermission('billing.read')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.holder(user);
    return this.payments.payInvoiceSession(user.tenantId, user.entrepriseId!, z.string().uuid().parse(id), await this.email(user));
  }

  private async email(user: AuthUser) {
    const r = await this.db.tx(ctxOf(user), (tx) => tx.query<{ email: string }>('SELECT email FROM utilisateur WHERE id = $1', [user.id]));
    return r.rows[0]?.email ?? null;
  }

  /** Webhook Stripe : corps brut signé (voir app.ts), rejouable sans effet de bord. */
  @Public()
  @Post('stripe/webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request, @Headers('stripe-signature') signature?: string) {
    if (!this.config.stripe.webhookSecret) throw new BusinessError(503, 'STRIPE_NON_CONFIGURE', 'Webhook Stripe non configuré');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    let event;
    try {
      event = verifyWebhook(raw, signature, this.config.stripe.webhookSecret);
    } catch (e) {
      throw new BusinessError(400, 'SIGNATURE_INVALIDE', (e as Error).message);
    }
    return this.payments.handleEvent(event);
  }
}

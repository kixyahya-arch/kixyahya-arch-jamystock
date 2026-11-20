import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { draftsDue } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { BillingService, systemCtx } from './billing.service.js';
import { PaymentsService } from '../payments/payments.service.js';

/**
 * Tâches de facturation (§6.1, FAC-02, FAC-03), vérifiées chaque minute :
 *  - instantané des m² à 23 h 59 (heure de Paris), avec rattrapage des jours manqués si le service dormait ;
 *  - brouillons du mois précédent le 1er à 2 h (une seule fois par mois, même après un redémarrage) ;
 *  - émission automatique des brouillons non bloqués à J+2 ;
 *  - prélèvement des factures émises quand le client a enregistré une carte ou un mandat SEPA.
 * Chaque étape est idempotente : plusieurs instances ou un redémarrage ne créent pas de doublon.
 */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.billingScheduler) return;
    // premier passage peu après le démarrage (rattrapage), puis toutes les minutes
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(at = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = this.config.defaultTenantId
        ? [this.config.defaultTenantId]
        : (await this.db.pool.query<{ id: string }>('SELECT id FROM organisation')).rows.map((r) => r.id);
      for (const tenantId of orgs) await this.runFor(tenantId, at);
    } catch (e) {
      console.error('Tâches de facturation :', (e as Error).message);
    } finally {
      this.running = false;
    }
  }

  /** Une passe complète pour une organisation ; renvoie ce qui a été fait (utile aux tests et au Back-Office). */
  async runFor(tenantId: string, at: Date) {
    const instantanes = await this.db.tx(systemCtx(tenantId), (tx) => this.billing.ensureSnapshots(tx, tenantId, at));
    let brouillons: { mois: string; crees: number } | null = null;
    const month = draftsDue(at);
    if (month) {
      brouillons = await this.db.tx(systemCtx(tenantId), async (tx) => {
        // la ligne de tâche sert de verrou : une seule génération automatique par mois
        const claim = await tx.query(`INSERT INTO tache_planifiee (tenant_id, cle) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING cle`, [tenantId, `brouillons:${month}`]);
        if (!claim.rowCount) return null;
        const r = await this.billing.generateDrafts(tx, tenantId, null, month, at);
        await tx.query(`UPDATE tache_planifiee SET resultat = $3 WHERE tenant_id = $1 AND cle = $2`, [tenantId, `brouillons:${month}`, JSON.stringify({ ...r, factures: r.factures.length })]);
        return { mois: month, crees: r.crees };
      });
    }
    const emises = await this.billing.autoIssue(tenantId, at);
    // ADM-04 : prélèvement des factures émises sur le moyen de paiement enregistré (Stripe)
    const prelevements = await this.payments.collectDue(tenantId).catch((e) => {
      console.error('Prélèvements :', (e as Error).message);
      return null;
    });
    return { instantanes, brouillons, emises, prelevements };
  }
}

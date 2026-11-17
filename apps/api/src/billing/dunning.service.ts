import { Inject, Injectable } from '@nestjs/common';
import { addIsoDays, daysLate, dunningLevelDue, parisClock, uuidv7 } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';
import { conflict, notFound } from '../common/errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { systemCtx } from './billing.service.js';

/** Réglages des relances, rangés dans organisation.parametres.relances. */
export interface DunningSettings {
  /** relances automatiques à J+7, J+15, J+30 (actives par défaut) */
  actives: boolean;
  /** refuser les nouvelles restitutions d'un client qui a une facture impayée depuis plus de 30 jours (désactivé par défaut) */
  blocageRestitutions: boolean;
}

export const DEFAULT_DUNNING: DunningSettings = { actives: true, blocageRestitutions: false };

/** Jours de retard au-delà desquels le blocage des restitutions s'applique, quand il est activé. */
export const BLOCKING_DAYS = 30;

export async function dunningSettings(tx: Tx): Promise<DunningSettings> {
  const r = await tx.query<{ p: Partial<DunningSettings> | null }>(`SELECT parametres->'relances' AS p FROM organisation WHERE id = app_tenant()`);
  return { ...DEFAULT_DUNNING, ...(r.rows[0]?.p ?? {}) };
}

/** Destinataires des messages de facturation : le contact facturation, à défaut les administrateurs du compte client. */
export async function billingRecipients(tx: Tx, entrepriseId: string): Promise<{ adresse?: string; destinataireId?: string }[]> {
  const e = (await tx.query<{ email_facturation: string | null }>('SELECT email_facturation FROM entreprise WHERE id = $1', [entrepriseId])).rows[0];
  if (e?.email_facturation) return [{ adresse: e.email_facturation }];
  const admins = await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE entreprise_id = $1 AND role IN ('B2B_ADMIN','B2C') AND statut = 'ACTIF'`, [entrepriseId]);
  return admins.rows.map((a) => ({ destinataireId: a.id }));
}

/**
 * Factures du client impayées depuis plus de 30 jours, quand le blocage des restitutions est activé.
 * Exécutée en contexte système : un utilisateur client ne voit pas forcément les factures de son entreprise.
 */
export async function blockingInvoices(tx: Tx, entrepriseId: string, today: string): Promise<string[]> {
  const s = await dunningSettings(tx);
  if (!s.blocageRestitutions) return [];
  const r = await tx.query<{ numero: string }>(
    `SELECT numero FROM facture WHERE entreprise_id = $1 AND type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD') AND echeance <= $2 ORDER BY echeance`,
    [entrepriseId, addIsoDays(today, -BLOCKING_DAYS)],
  );
  return r.rows.map((x) => x.numero);
}

interface DueRow {
  id: string;
  numero: string;
  entreprise_id: string;
  echeance: string;
  total_ttc_cents: number;
  paye_cents: number;
  relance_niveau: number;
}

/**
 * FAC-05 : passage en retard des factures échues et relances par e-mail à J+7, J+15, J+30.
 * Idempotent : un palier n'est envoyé qu'une fois par facture (index unique), même si plusieurs instances tournent.
 */
@Injectable()
export class DunningService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async run(tenantId: string, at = new Date()): Promise<{ enRetard: number; relances: number }> {
    const today = parisClock(at).date;
    return this.db.tx(systemCtx(tenantId), async (tx) => {
      const late = await tx.query(
        `UPDATE facture SET statut = 'EN_RETARD', updated_at = now() WHERE type = 'FACTURE' AND statut = 'EMISE' AND echeance < $1`,
        [today],
      );
      const settings = await dunningSettings(tx);
      let relances = 0;
      if (settings.actives) {
        for (const f of await this.overdue(tx, today, null)) {
          const level = dunningLevelDue(f.echeance, today, f.relance_niveau);
          if (!level) continue;
          const claim = await tx.query(
            `INSERT INTO relance (id, tenant_id, facture_id, niveau, envoyee_le) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
            [uuidv7(), tenantId, f.id, level, at],
          );
          if (!claim.rowCount) continue;
          const n = await this.send(tx, tenantId, f, level, today);
          await tx.query('UPDATE relance SET destinataires = $2 WHERE id = $1', [claim.rows[0].id, n]);
          await tx.query('UPDATE facture SET relance_niveau = $2, derniere_relance_le = $3 WHERE id = $1', [f.id, level, at]);
          relances++;
        }
      }
      return { enRetard: late.rowCount ?? 0, relances };
    });
  }

  /** Relance manuelle depuis le Back-Office (hors palier), tracée dans l'historique des relances et l'audit. */
  async remind(user: AuthUser, factureId: string, at = new Date()): Promise<{ destinataires: number }> {
    const today = parisClock(at).date;
    return this.db.tx({ tenantId: user.tenantId, userId: user.id, role: user.role }, async (tx) => {
      const f = (await this.overdue(tx, '9999-12-31', factureId))[0];
      if (!f) {
        const exists = (await tx.query('SELECT 1 FROM facture WHERE id = $1', [factureId])).rowCount;
        if (!exists) throw notFound('Facture');
        throw conflict('STATUT', 'Seule une facture émise et non réglée peut être relancée');
      }
      const n = await this.send(tx, user.tenantId, f, 0, today);
      if (!n) throw conflict('SANS_DESTINATAIRE', 'Aucun destinataire : renseignez l’e-mail de facturation du client ou activez un administrateur');
      await tx.query(`INSERT INTO relance (id, tenant_id, facture_id, niveau, manuelle, envoyee_le, destinataires, par) VALUES ($1,$2,$3,0,true,$4,$5,$6)`, [
        uuidv7(), user.tenantId, f.id, at, n, user.id,
      ]);
      await tx.query('UPDATE facture SET derniere_relance_le = $2 WHERE id = $1', [f.id, at]);
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id, apres) VALUES ($1,$2,$3,$4,'RELANCE_MANUELLE','facture',$5,$6)`,
        [uuidv7(), user.tenantId, f.entreprise_id, user.id, f.id, JSON.stringify({ numero: f.numero, destinataires: n })],
      );
      return { destinataires: n };
    });
  }

  /** Historique des relances d'une facture. */
  history(tx: Tx, factureId: string) {
    return tx
      .query(
        `SELECT r.niveau, r.manuelle, r.envoyee_le AS "envoyeeLe", r.destinataires, u.nom AS par
           FROM relance r LEFT JOIN utilisateur u ON u.id = r.par WHERE r.facture_id = $1 ORDER BY r.envoyee_le`,
        [factureId],
      )
      .then((r) => r.rows);
  }

  private async overdue(tx: Tx, today: string, id: string | null): Promise<DueRow[]> {
    const r = await tx.query<DueRow>(
      `SELECT f.id, f.numero, f.entreprise_id, f.echeance::text AS echeance, f.total_ttc_cents, f.relance_niveau,
              coalesce((SELECT sum(p.montant_cents) FROM paiement p WHERE p.facture_id = f.id), 0)::int AS paye_cents
         FROM facture f
        WHERE f.type = 'FACTURE' AND f.statut IN ('EMISE','EN_RETARD') AND f.echeance IS NOT NULL AND f.echeance < $1
          AND ($2::uuid IS NULL OR f.id = $2)
        ORDER BY f.echeance, f.numero`,
      [today, id],
    );
    return r.rows;
  }

  private async send(tx: Tx, tenantId: string, f: DueRow, level: number, today: string): Promise<number> {
    const to = await billingRecipients(tx, f.entreprise_id);
    const variables = {
      factureId: f.id,
      numero: f.numero,
      niveau: level,
      echeance: f.echeance,
      joursRetard: daysLate(f.echeance, today),
      resteCents: Math.max(0, f.total_ttc_cents - f.paye_cents),
      blocage: (await dunningSettings(tx)).blocageRestitutions && daysLate(f.echeance, today) >= BLOCKING_DAYS,
    };
    for (const r of to) await NotificationsService.enqueue(tx, tenantId, { modele: 'RELANCE_IMPAYE', ...r, variables });
    return to.length;
  }
}

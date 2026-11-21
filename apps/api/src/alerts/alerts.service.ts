import { Inject, Injectable } from '@nestjs/common';
import { addIsoDays, dormantReportQuarter, dormantSince, evaluateAlerts, parisClock, type AlertRule } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Heure (Paris) à partir de laquelle les alertes du jour partent : les instantanés de la veille sont faits. */
const ALERT_HOUR = 7;
/** Statuts où un bien est au dépôt et peut donc « dormir ». */
const AU_DEPOT = `('EN_STOCK','RESERVE')`;

const MODELE: Record<'RG-AL-01' | 'RG-AL-02' | 'RG-AL-04', string> = {
  'RG-AL-01': 'ALERTE_PRE',
  'RG-AL-02': 'ALERTE_DEPASSEMENT',
  'RG-AL-04': 'ALERTE_SOUS_UTILISATION',
};

/**
 * Alertes de forfait (§6.2), passées une fois par jour et par organisation :
 *  - RG-AL-01 pré-alerte à 90 % : administrateurs du client et exploitant ;
 *  - RG-AL-02 dépassement 3 jours de suite : administrateurs du client (avec le coût du dépassement) et Super Admin ;
 *  - RG-AL-04 sous-utilisation 60 jours : exploitant seul (proposer un forfait ajusté) ;
 *  - RG-AL-05 rapport trimestriel des biens dormants (12 mois sans mouvement) : administrateurs du client.
 * Une alerte identique ne repart pas avant 7 jours (table alerte_envoyee). RG-AL-03 est traitée à la demande de collecte.
 */
@Injectable()
export class AlertsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async run(tenantId: string, at: Date): Promise<{ alertes: number; dormants: number } | null> {
    const clock = parisClock(at);
    if (clock.hour < ALERT_HOUR) return null;
    return this.db.tx({ tenantId, role: 'SYSTEM' }, async (tx) => {
      // la ligne de tâche sert de verrou : une seule passe par jour, même avec plusieurs instances
      const claim = await tx.query(`INSERT INTO tache_planifiee (tenant_id, cle) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING cle`, [tenantId, `alertes:${clock.date}`]);
      if (!claim.rowCount) return null;
      const alertes = await this.forfaitAlerts(tx, tenantId, clock.date);
      const dormants = await this.dormantReports(tx, tenantId, at, clock.date);
      await tx.query(`UPDATE tache_planifiee SET resultat = $3 WHERE tenant_id = $1 AND cle = $2`, [tenantId, `alertes:${clock.date}`, JSON.stringify({ alertes, dormants })]);
      return { alertes, dormants };
    });
  }

  private async forfaitAlerts(tx: Tx, tenantId: string, today: string): Promise<number> {
    const forfaits = await tx.query<{ entreprise_id: string; nom: string; m2_inclus: number; prix_m2_depassement_cents: number }>(
      `SELECT DISTINCT ON (f.entreprise_id) f.entreprise_id, e.nom, f.m2_inclus::float AS m2_inclus, f.prix_m2_depassement_cents
         FROM forfait f JOIN entreprise e ON e.id = f.entreprise_id
        WHERE f.statut = 'ACTIF' AND f.date_debut <= $1 AND (f.date_fin IS NULL OR f.date_fin >= $1) AND f.m2_inclus > 0
        ORDER BY f.entreprise_id, f.version DESC`,
      [today],
    );
    let sent = 0;
    for (const f of forfaits.rows) {
      const history = (
        await tx.query<{ m2: number }>(
          `SELECT m2 FROM (SELECT date, m2_occupes::float AS m2 FROM instantane_occupation
                            WHERE entreprise_id = $1 AND projet_id IS NULL AND depot_id IS NULL AND date < $2 AND date >= $3
                            ORDER BY date DESC LIMIT 60) h ORDER BY date`,
          [f.entreprise_id, today, addIsoDays(today, -60)],
        )
      ).rows.map((r) => r.m2);
      const fired = evaluateAlerts({ includedM2: f.m2_inclus, history, lastSentAt: await this.lastSent(tx, f.entreprise_id), today });
      for (const rule of fired) {
        if (rule !== 'RG-AL-01' && rule !== 'RG-AL-02' && rule !== 'RG-AL-04') continue;
        const current = history[history.length - 1] ?? 0;
        const over = Math.max(0, current - f.m2_inclus);
        const vars = {
          entreprise: f.nom,
          m2Occupes: round1(current),
          m2Inclus: f.m2_inclus,
          taux: Math.round((current / f.m2_inclus) * 100),
          m2Depassement: round1(over),
          // simulation du coût mensuel du dépassement au rythme actuel (RG-AL-02)
          coutMensuelCents: Math.round(Math.ceil(over * 2) / 2 * f.prix_m2_depassement_cents),
        };
        const clients = rule === 'RG-AL-04' ? [] : await this.clientAdmins(tx, f.entreprise_id);
        const staff = await this.superAdmins(tx);
        for (const id of [...clients, ...staff]) await NotificationsService.enqueue(tx, tenantId, { modele: MODELE[rule], destinataireId: id, variables: { ...vars, copieExploitant: staff.includes(id) } });
        await this.mark(tx, tenantId, f.entreprise_id, rule, today, vars);
        sent++;
      }
    }
    return sent;
  }

  /**
   * RG-AL-05 : un rapport par client et par trimestre, envoyé au premier passage des 15 premiers jours du trimestre
   * (1er janvier, avril, juillet, octobre) ; pas de rapport en cours de trimestre, juste après une reprise de données.
   */
  private async dormantReports(tx: Tx, tenantId: string, at: Date, today: string): Promise<number> {
    const [, m, d] = today.split('-').map(Number) as [number, number, number];
    if ((m - 1) % 3 !== 0 || d > 15) return 0;
    const quarter = dormantReportQuarter(at);
    const claim = await tx.query(`INSERT INTO tache_planifiee (tenant_id, cle) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING cle`, [tenantId, `dormants:${quarter}`]);
    if (!claim.rowCount) return 0;
    const rows = await tx.query<{ entreprise_id: string; n: number }>(
      `SELECT entreprise_id, count(*)::int AS n FROM article
        WHERE statut IN ${AU_DEPOT} AND coalesce(dernier_mouvement_le, date_entree, created_at) < $1
        GROUP BY entreprise_id`,
      [dormantSince(at)],
    );
    for (const r of rows.rows) {
      for (const id of await this.clientAdmins(tx, r.entreprise_id)) {
        await NotificationsService.enqueue(tx, tenantId, { modele: 'RAPPORT_DORMANTS', destinataireId: id, variables: { nbArticles: r.n, trimestre: quarter } });
      }
      await this.mark(tx, tenantId, r.entreprise_id, 'RG-AL-05', today, { nbArticles: r.n, trimestre: quarter });
    }
    return rows.rows.length;
  }

  private async lastSent(tx: Tx, entrepriseId: string): Promise<Partial<Record<AlertRule, string>>> {
    const r = await tx.query<{ regle: AlertRule; d: string }>(`SELECT regle, max(envoyee_le)::text AS d FROM alerte_envoyee WHERE entreprise_id = $1 GROUP BY regle`, [entrepriseId]);
    return Object.fromEntries(r.rows.map((x) => [x.regle, x.d]));
  }

  private async mark(tx: Tx, tenantId: string, entrepriseId: string, rule: AlertRule, day: string, details: Record<string, unknown>) {
    await tx.query(
      `INSERT INTO alerte_envoyee (tenant_id, entreprise_id, regle, envoyee_le, details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tenantId, entrepriseId, rule, day, JSON.stringify(details)],
    );
  }

  private async clientAdmins(tx: Tx, entrepriseId: string): Promise<string[]> {
    return (await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE entreprise_id = $1 AND role IN ('B2B_ADMIN','B2C') AND statut = 'ACTIF'`, [entrepriseId])).rows.map((r) => r.id);
  }

  private async superAdmins(tx: Tx): Promise<string[]> {
    return (await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE role = 'SUPER_ADMIN' AND statut = 'ACTIF'`)).rows.map((r) => r.id);
  }

  /** RG-AL-03 : une collecte demandée par un utilisateur fera dépasser le forfait ; ses administrateurs sont prévenus. */
  static async notifyForecast(tx: Tx, tenantId: string, entrepriseId: string, requesterId: string, vars: Record<string, unknown>) {
    const admins = await tx.query<{ id: string }>(
      `SELECT id FROM utilisateur WHERE entreprise_id = $1 AND role = 'B2B_ADMIN' AND statut = 'ACTIF' AND id <> $2`,
      [entrepriseId, requesterId],
    );
    for (const a of admins.rows) await NotificationsService.enqueue(tx, tenantId, { modele: 'ALERTE_PREVISION', destinataireId: a.id, variables: vars });
    await tx.query(
      `INSERT INTO alerte_envoyee (tenant_id, entreprise_id, regle, envoyee_le, details) VALUES ($1,$2,'RG-AL-03',(now() AT TIME ZONE 'Europe/Paris')::date,$3) ON CONFLICT DO NOTHING`,
      [tenantId, entrepriseId, JSON.stringify(vars)],
    );
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;

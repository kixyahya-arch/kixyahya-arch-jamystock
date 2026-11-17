import { Controller, Get, Inject } from '@nestjs/common';
import { addIsoDays, monthBounds, parisClock } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';

/** Statuts où un article occupe physiquement un emplacement. */
const ON_SHELF = ['EN_RECEPTION', 'EN_STOCK', 'RESERVE', 'EN_PREPARATION'];
/** Commandes encore en cours (ni terminées, ni refusées, ni annulées). */
const OPEN_ORDERS = ['EN_ATTENTE_VALIDATION', 'SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE', 'EN_LIVRAISON'];

/**
 * CLI-03 : tableau de bord de pilotage du Super Admin. Le Back-Office le recharge toutes les 15 minutes et
 * l'exporte en CSV.
 *  - remplissage d'un dépôt : surface des emplacements de stockage occupés (un article, une UM ou un client dédié)
 *    rapportée à la surface de tous ses emplacements de stockage ;
 *  - CA récurrent : somme des forfaits mensuels actifs (HT) ;
 *  - retards : commandes dont la date prévue est passée, missions du jour pas démarrées à l'heure, factures échues.
 */
@Controller('bo/pilotage')
export class PilotageController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @RequirePermission('pricing.manage')
  dashboard(@CurrentUser() user: AuthUser) {
    const now = new Date();
    const today = parisClock(now).date;
    const thisMonth = monthBounds(today.slice(0, 7));
    const lastMonth = monthBounds(addIsoDays(thisMonth.start, -1).slice(0, 7));
    return this.db.tx(ctxOf(user), async (tx) => {
      const depots = (
        await tx.query(
          `WITH em AS (
             SELECT z.depot_id, e.id, e.surface_m2::float AS s,
                    (e.dedie_entreprise_id IS NOT NULL
                     OR EXISTS (SELECT 1 FROM article a WHERE a.emplacement_courant_id = e.id AND a.statut::text = ANY($1))
                     OR EXISTS (SELECT 1 FROM unite_manutention u WHERE u.emplacement_courant_id = e.id AND u.actif)) AS occupe
               FROM emplacement e JOIN zone z ON z.id = e.zone_id
              WHERE e.adressable AND z.type = 'STOCKAGE' AND e.statut = 'ACTIF')
           SELECT d.id, d.nom, d.code, d.surface_totale_m2::float AS "surfaceTotaleM2",
                  coalesce(sum(em.s), 0)::float AS "surfaceStockageM2",
                  coalesce(sum(em.s) FILTER (WHERE em.occupe), 0)::float AS "occupeeM2",
                  count(em.id)::int AS emplacements,
                  count(em.id) FILTER (WHERE em.occupe)::int AS "emplacementsOccupes",
                  (SELECT count(*)::int FROM article a JOIN emplacement e2 ON e2.id = a.emplacement_courant_id JOIN zone z2 ON z2.id = e2.zone_id
                    WHERE z2.depot_id = d.id AND a.statut::text = ANY($1)) AS articles
             FROM depot d LEFT JOIN em ON em.depot_id = d.id
            GROUP BY d.id ORDER BY d.nom`,
          [ON_SHELF],
        )
      ).rows.map((d) => ({ ...d, taux: d.surfaceStockageM2 > 0 ? Math.round((d.occupeeM2 / d.surfaceStockageM2) * 1000) / 10 : null }));

      const tendance = (
        await tx.query<{ date: string; m2: number }>(
          `SELECT date::text, sum(m2_occupes)::float AS m2 FROM instantane_occupation
            WHERE projet_id IS NULL AND depot_id IS NULL AND date BETWEEN $1 AND $2 GROUP BY date ORDER BY date`,
          [addIsoDays(today, -59), today],
        )
      ).rows;

      const ca = (
        await tx.query(
          `SELECT (SELECT coalesce(sum(prix_mensuel_cents), 0)::bigint FROM forfait
                    WHERE statut = 'ACTIF' AND date_debut <= $1 AND (date_fin IS NULL OR date_fin >= $1)) AS "recurrentCents",
                  (SELECT count(DISTINCT entreprise_id)::int FROM forfait
                    WHERE statut = 'ACTIF' AND date_debut <= $1 AND (date_fin IS NULL OR date_fin >= $1)) AS "clientsSousForfait",
                  coalesce(sum(total_ht_cents) FILTER (WHERE (emise_le AT TIME ZONE 'Europe/Paris')::date BETWEEN $2 AND $3), 0)::bigint AS "factureMoisHtCents",
                  coalesce(sum(total_ht_cents) FILTER (WHERE (emise_le AT TIME ZONE 'Europe/Paris')::date BETWEEN $4 AND $5), 0)::bigint AS "factureMoisPrecedentHtCents",
                  coalesce(sum(total_ttc_cents) FILTER (WHERE type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD')), 0)::bigint AS "aEncaisserCents",
                  coalesce(sum(total_ttc_cents) FILTER (WHERE type = 'FACTURE' AND statut IN ('EMISE','EN_RETARD') AND echeance < $1), 0)::bigint AS "echuCents"
             FROM facture WHERE statut <> 'BROUILLON'`,
          [today, thisMonth.start, thisMonth.end, lastMonth.start, lastMonth.end],
        )
      ).rows[0];

      const missions = (
        await tx.query<{ type: string; statut: string; n: number }>(
          `SELECT type::text, statut::text, count(*)::int AS n FROM mission
            WHERE (debut_prevu AT TIME ZONE 'Europe/Paris')::date = $1 GROUP BY type, statut`,
          [today],
        )
      ).rows;

      const commandesEnRetard = (
        await tx.query(
          `SELECT c.id, c.numero, c.type, c.statut, e.nom AS client, coalesce(c.date_confirmee, c.date_souhaitee)::text AS date
             FROM commande c JOIN entreprise e ON e.id = c.entreprise_id
            WHERE c.statut::text = ANY($1) AND coalesce(c.date_confirmee, c.date_souhaitee) < $2
            ORDER BY coalesce(c.date_confirmee, c.date_souhaitee), c.numero LIMIT 50`,
          [OPEN_ORDERS, today],
        )
      ).rows;
      const missionsEnRetard = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM mission WHERE statut IN ('A_AFFECTER','AFFECTEE') AND debut_prevu < $1 AND (debut_prevu AT TIME ZONE 'Europe/Paris')::date >= $2`,
          [now, addIsoDays(today, -7)],
        )
      ).rows[0]!.n;
      const facturesEnRetard = (
        await tx.query(
          `SELECT f.id, f.numero, e.nom AS client, f.echeance::text AS echeance, f.total_ttc_cents AS "totalTtcCents", f.relance_niveau AS "relanceNiveau"
             FROM facture f JOIN entreprise e ON e.id = f.entreprise_id
            WHERE f.type = 'FACTURE' AND f.statut IN ('EMISE','EN_RETARD') AND f.echeance < $1 ORDER BY f.echeance LIMIT 50`,
          [today],
        )
      ).rows;

      const num = (v: unknown) => Number(v ?? 0);
      return {
        maj: now.toISOString(),
        today,
        depots,
        surfaceFacturee: tendance.at(-1) ?? null,
        tendance,
        ca: {
          recurrentCents: num(ca.recurrentCents),
          clientsSousForfait: ca.clientsSousForfait,
          factureMoisHtCents: num(ca.factureMoisHtCents),
          factureMoisPrecedentHtCents: num(ca.factureMoisPrecedentHtCents),
          aEncaisserCents: num(ca.aEncaisserCents),
          echuCents: num(ca.echuCents),
        },
        missions: { total: missions.reduce((s, m) => s + m.n, 0), lignes: missions },
        retards: { commandes: commandesEnRetard, missions: missionsEnRetard, factures: facturesEnRetard },
      };
    });
  }
}

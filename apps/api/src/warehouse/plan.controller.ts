import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { formatDocumentNumber, sortByPath, uuidv7, type ArticleStatus } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { fillOf, round2, usageColumns, type Fill } from './occupancy.js';

const uuid = z.string().uuid();

interface LocUsage {
  id: string;
  zone_id: string;
  code: string;
  chemin: string;
  statut: string;
  surface_m2: number;
  occupe_m2: number;
  nb_articles: number;
}

/** WMS-04 : plan du dépôt, occupation de chaque zone et de chaque emplacement ; contenu d'une zone. */
@Controller('bo/warehouse')
export class WarehousePlanController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('depots/:id/plan')
  @RequirePermission('warehouse.manage')
  plan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const depot = (await tx.query<{ id: string; nom: string; code: string }>('SELECT id, nom, code FROM depot WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!depot) throw notFound('Dépôt');
      const zones = (await tx.query<{ id: string; code: string; nom: string; type: string }>('SELECT id, code, nom, type FROM zone WHERE depot_id = $1 ORDER BY code', [id])).rows;
      const locs = (
        await tx.query<LocUsage>(
          `SELECT e.id, e.zone_id, e.code, e.chemin, e.statut, e.surface_m2::float AS surface_m2, ${usageColumns('e')}
             FROM emplacement e JOIN zone z ON z.id = e.zone_id
            WHERE z.depot_id = $1 AND e.adressable`,
          [id],
        )
      ).rows;
      const clients = await tx.query<{ zone_id: string; n: number }>(
        `SELECT e.zone_id, count(DISTINCT a.entreprise_id)::int AS n
           FROM article a JOIN emplacement e ON e.id = a.emplacement_courant_id JOIN zone z ON z.id = e.zone_id
          WHERE z.depot_id = $1 AND a.statut IN ('EN_STOCK','RESERVE','EN_PREPARATION') GROUP BY e.zone_id`,
        [id],
      );
      const campagnes = await tx.query<{ zone_id: string; id: string; numero: string; statut: string }>(
        `SELECT zone_id, id, numero, statut FROM inventaire WHERE depot_id = $1 AND statut IN ('EN_COURS','A_ARBITRER')`,
        [id],
      );
      return {
        depot,
        zones: zones.map((z0) => {
          const mine = sortByPath(locs.filter((l) => l.zone_id === z0.id));
          const measured = mine.filter((l) => l.statut === 'ACTIF' && l.surface_m2 > 0);
          const surface = measured.reduce((s, l) => s + l.surface_m2, 0);
          const occupe = measured.reduce((s, l) => s + Math.min(l.occupe_m2, l.surface_m2 * 1.5), 0);
          const fills = mine.map((l) => fillOf(l));
          const count = (f: Fill) => fills.filter((x) => x === f).length;
          const taux = surface > 0 ? occupe / surface : null;
          const anyUsed = mine.some((l) => l.nb_articles > 0);
          return {
            ...z0,
            surfaceM2: round2(surface),
            occupeM2: round2(occupe),
            taux: taux == null ? null : Math.round(taux * 1000) / 1000,
            etat: taux == null ? (anyUsed ? 'PARTIEL' : 'LIBRE') : taux >= 0.9 ? 'PLEIN' : taux > 0 || anyUsed ? 'PARTIEL' : 'LIBRE',
            nbEmplacements: mine.length,
            libres: count('LIBRE'),
            partiels: count('PARTIEL'),
            pleins: count('PLEIN'),
            indisponibles: count('INDISPONIBLE'),
            nbArticles: mine.reduce((s, l) => s + l.nb_articles, 0),
            nbClients: clients.rows.find((c) => c.zone_id === z0.id)?.n ?? 0,
            inventaire: campagnes.rows.find((c) => c.zone_id === z0.id) ?? null,
            emplacements: mine.map((l, i) => ({
              id: l.id,
              code: l.code,
              chemin: l.chemin,
              surfaceM2: l.surface_m2,
              occupeM2: round2(l.occupe_m2),
              nbArticles: l.nb_articles,
              etat: fills[i],
            })),
          };
        }),
      };
    });
  }

  /** Clic sur une zone : clients présents et articles, emplacement par emplacement. */
  @Get('zones/:id/contents')
  @RequirePermission('warehouse.manage')
  contents(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('emplacement') emplacement?: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const zone = (
        await tx.query<{ id: string; code: string; nom: string; type: string; depot: string }>(
          'SELECT z.id, z.code, z.nom, z.type, d.nom AS depot FROM zone z JOIN depot d ON d.id = z.depot_id WHERE z.id = $1',
          [uuid.parse(id)],
        )
      ).rows[0];
      if (!zone) throw notFound('Zone');
      const loc = emplacement ? uuid.parse(emplacement) : null;
      const articles = (
        await tx.query<{ id: string; chemin: string }>(
          `SELECT a.id, a.qr_code AS "qrCode", a.libelle, a.statut, en.id AS "entrepriseId", en.nom AS client, p.nom AS projet,
                  e.id AS "emplacementId", e.code AS "emplacementCode", e.chemin, u.qr_code AS "umQr"
             FROM article a JOIN emplacement e ON e.id = a.emplacement_courant_id
             JOIN entreprise en ON en.id = a.entreprise_id
             LEFT JOIN projet p ON p.id = a.projet_id
             LEFT JOIN unite_manutention u ON u.id = a.um_courante_id
            WHERE e.zone_id = $1 AND a.statut IN ('EN_STOCK','RESERVE','EN_PREPARATION') AND ($2::uuid IS NULL OR e.id = $2)
            LIMIT 2000`,
          [id, loc],
        )
      ).rows;
      const sorted = sortByPath(articles);
      const byClient = new Map<string, { entrepriseId: string; client: string; nbArticles: number; projets: Set<string> }>();
      for (const a of sorted as unknown as { entrepriseId: string; client: string; projet: string | null }[]) {
        const c = byClient.get(a.entrepriseId) ?? { entrepriseId: a.entrepriseId, client: a.client, nbArticles: 0, projets: new Set<string>() };
        c.nbArticles++;
        if (a.projet) c.projets.add(a.projet);
        byClient.set(a.entrepriseId, c);
      }
      return {
        zone,
        clients: [...byClient.values()].sort((a, b) => b.nbArticles - a.nbArticles).map((c) => ({ ...c, projets: [...c.projets].sort() })),
        articles: sorted,
      };
    });
  }
}

// =====================================================================================
// WMS-05 : inventaire tournant
// =====================================================================================

const LaunchBody = z.object({
  zoneId: uuid,
  /** Emplacements par mission de comptage : une mission tient dans une demi-journée. */
  parMission: z.number().int().min(5).max(200).default(30),
  date: z.string().date().optional(),
  assigneA: uuid.optional(),
});
const DecisionBody = z.object({ decision: z.enum(['CORRIGE', 'PERDU', 'IGNORE']), motif: z.string().trim().min(3, 'Motif obligatoire (3 caractères minimum)').max(500) });

interface EcartRow {
  id: string;
  inventaire_id: string;
  emplacement_id: string;
  type: 'MANQUANT' | 'DEPLACE' | 'INCONNU';
  article_id: string | null;
  decision: string | null;
}

@Controller('bo/inventaires')
export class InventoryCountController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('warehouse.manage')
  list(@CurrentUser() user: AuthUser, @Query('statut') statut?: string) {
    const s = statut ? z.enum(['EN_COURS', 'A_ARBITRER', 'CLOS', 'ANNULE', 'OUVERTS']).parse(statut) : null;
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT i.id, i.numero, i.statut, i.lance_le AS "lanceLe", i.termine_le AS "termineLe", i.clos_le AS "closLe", i.nb_emplacements AS "nbEmplacements",
                d.id AS "depotId", d.nom AS depot, z.id AS "zoneId", z.code AS "zoneCode", z.nom AS zone, u.nom AS "lancePar",
                (SELECT count(*)::int FROM inventaire_comptage c WHERE c.inventaire_id = i.id AND c.compte_le IS NOT NULL) AS comptes,
                (SELECT count(*)::int FROM inventaire_ecart x WHERE x.inventaire_id = i.id) AS ecarts,
                (SELECT count(*)::int FROM inventaire_ecart x WHERE x.inventaire_id = i.id AND x.decision IS NULL) AS "aArbitrer"
           FROM inventaire i JOIN depot d ON d.id = i.depot_id JOIN zone z ON z.id = i.zone_id LEFT JOIN utilisateur u ON u.id = i.lance_par
          WHERE ($1::text IS NULL OR i.statut = $1 OR ($1 = 'OUVERTS' AND i.statut IN ('EN_COURS','A_ARBITRER')))
          ORDER BY i.lance_le DESC LIMIT 200`,
        [s],
      );
      return { items: r.rows };
    });
  }

  @Post()
  @RequirePermission('warehouse.manage')
  launch(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = LaunchBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const zone = (
        await tx.query<{ id: string; code: string; nom: string; depot_id: string }>('SELECT id, code, nom, depot_id FROM zone WHERE id = $1', [b.zoneId])
      ).rows[0];
      if (!zone) throw notFound('Zone');
      const open = (await tx.query<{ numero: string }>(`SELECT numero FROM inventaire WHERE zone_id = $1 AND statut IN ('EN_COURS','A_ARBITRER')`, [zone.id])).rows[0];
      if (open) throw conflict('INVENTAIRE_EN_COURS', `L’inventaire ${open.numero} est déjà ouvert sur cette zone : terminez-le ou annulez-le`);
      if (b.assigneA) {
        const op = (await tx.query<{ role: string; statut: string }>('SELECT role, statut FROM utilisateur WHERE id = $1', [b.assigneA])).rows[0];
        if (!op || op.statut !== 'ACTIF' || !['OPERATOR', 'SUPER_ADMIN'].includes(op.role)) throw unprocessable('OPERATEUR', 'Choisissez un opérateur actif');
      }
      const locs = sortByPath(
        (await tx.query<{ id: string; chemin: string }>(`SELECT id, chemin FROM emplacement WHERE zone_id = $1 AND adressable AND statut = 'ACTIF'`, [zone.id])).rows,
      );
      if (!locs.length) throw unprocessable('ZONE_VIDE', 'Aucun emplacement actif à compter dans cette zone');

      const now = new Date();
      const year = now.getUTCFullYear();
      const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [user.tenantId, 'INV', year])).rows[0]!.n;
      const id = uuidv7();
      const numero = formatDocumentNumber('INV', year, seq);
      await tx.query(
        `INSERT INTO inventaire (id, tenant_id, numero, depot_id, zone_id, nb_emplacements, lance_par) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, user.tenantId, numero, zone.depot_id, zone.id, locs.length, user.id],
      );
      const date = b.date ?? now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
      const missions: string[] = [];
      for (let i = 0; i < locs.length; i += b.parMission) {
        const part = locs.slice(i, i + b.parMission);
        const missionId = uuidv7();
        missions.push(missionId);
        await tx.query(
          `INSERT INTO mission (id, tenant_id, depot_id, type, statut, assigne_a, debut_prevu, donnees)
           VALUES ($1,$2,$3,'INVENTAIRE',$4,$5,($6::date + time '08:00') AT TIME ZONE 'Europe/Paris',$7)`,
          [
            missionId, user.tenantId, zone.depot_id, b.assigneA ? 'AFFECTEE' : 'A_AFFECTER', b.assigneA ?? null, date,
            JSON.stringify({ inventaireId: id, numero, zone: `${zone.nom} (${zone.code})`, partie: missions.length, emplacements: part.length }),
          ],
        );
        for (const [k, l] of part.entries()) {
          await tx.query(
            `INSERT INTO inventaire_comptage (id, tenant_id, inventaire_id, mission_id, emplacement_id, ordre) VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuidv7(), user.tenantId, id, missionId, l.id, k],
          );
        }
      }
      await this.audit.record(tx, user, { action: 'INVENTAIRE_LANCE', objet: 'inventaire', objetId: id, apres: { numero, zone: zone.code, emplacements: locs.length, missions: missions.length } });
      return { id, numero, nbEmplacements: locs.length, missions };
    });
  }

  @Get(':id')
  @RequirePermission('warehouse.manage')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const inv = (
        await tx.query(
          `SELECT i.id, i.numero, i.statut, i.lance_le AS "lanceLe", i.termine_le AS "termineLe", i.clos_le AS "closLe", i.nb_emplacements AS "nbEmplacements",
                  d.id AS "depotId", d.nom AS depot, z.id AS "zoneId", z.code AS "zoneCode", z.nom AS zone, u.nom AS "lancePar"
             FROM inventaire i JOIN depot d ON d.id = i.depot_id JOIN zone z ON z.id = i.zone_id LEFT JOIN utilisateur u ON u.id = i.lance_par
            WHERE i.id = $1`,
          [uuid.parse(id)],
        )
      ).rows[0];
      if (!inv) throw notFound('Inventaire');
      const missions = await tx.query(
        `SELECT m.id, m.statut, m.debut_prevu AS "debutPrevu", u.nom AS assigne, (m.donnees->>'partie')::int AS partie,
                count(c.id)::int AS "nbEmplacements", count(c.compte_le)::int AS comptes
           FROM mission m JOIN inventaire_comptage c ON c.mission_id = m.id LEFT JOIN utilisateur u ON u.id = m.assigne_a
          WHERE c.inventaire_id = $1 GROUP BY m.id, u.nom ORDER BY partie`,
        [id],
      );
      const ecarts = await tx.query(
        `SELECT x.id, x.type, x.qr, x.decision, x.motif, x.decide_le AS "decideLe", ud.nom AS "decidePar",
                e.id AS "emplacementId", e.code AS "emplacementCode", e.chemin AS emplacement,
                es.code AS "emplacementSystemeCode", es.chemin AS "emplacementSysteme",
                a.id AS "articleId", a.qr_code AS "articleQr", a.libelle, a.statut AS "statutArticle", en.nom AS client,
                (a.emplacement_courant_id IS DISTINCT FROM CASE WHEN x.type = 'MANQUANT' THEN x.emplacement_id ELSE x.emplacement_systeme_id END) AS "aBouge"
           FROM inventaire_ecart x JOIN emplacement e ON e.id = x.emplacement_id
           LEFT JOIN emplacement es ON es.id = x.emplacement_systeme_id
           LEFT JOIN article a ON a.id = x.article_id LEFT JOIN entreprise en ON en.id = a.entreprise_id
           LEFT JOIN utilisateur ud ON ud.id = x.decide_par
          WHERE x.inventaire_id = $1
          ORDER BY x.decision NULLS FIRST, e.chemin, x.type`,
        [id],
      );
      const comptages = await tx.query(
        `SELECT e.code, e.chemin, c.compte_le AS "compteLe", cardinality(c.attendus) AS attendus, cardinality(c.trouves) AS trouves, cardinality(c.inconnus) AS inconnus
           FROM inventaire_comptage c JOIN emplacement e ON e.id = c.emplacement_id WHERE c.inventaire_id = $1`,
        [id],
      );
      return { ...inv, missions: missions.rows, ecarts: ecarts.rows, comptages: sortByPath(comptages.rows as { chemin: string }[]) };
    });
  }

  /** Arbitrage d'un écart : correction tracée (mouvement « Ajustement » avec motif, RG WMS-06) ou écart ignoré. */
  @Post(':id/ecarts/:ecartId')
  @RequirePermission('warehouse.manage')
  decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('ecartId') ecartId: string, @Body() body: unknown) {
    const b = DecisionBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const inv = (await tx.query<{ id: string; numero: string; statut: string }>('SELECT id, numero, statut FROM inventaire WHERE id = $1 FOR UPDATE', [uuid.parse(id)])).rows[0];
      if (!inv) throw notFound('Inventaire');
      if (inv.statut === 'ANNULE' || inv.statut === 'CLOS') throw conflict('INVENTAIRE_CLOS', `Inventaire ${inv.statut === 'CLOS' ? 'clos' : 'annulé'}`);
      const x = (await tx.query<EcartRow>('SELECT * FROM inventaire_ecart WHERE id = $1 AND inventaire_id = $2 FOR UPDATE', [uuid.parse(ecartId), inv.id])).rows[0];
      if (!x) throw notFound('Écart');
      if (x.decision) throw conflict('ECART_TRAITE', 'Écart déjà arbitré');
      const allowed: Record<EcartRow['type'], string[]> = { MANQUANT: ['PERDU', 'IGNORE'], DEPLACE: ['CORRIGE', 'IGNORE'], INCONNU: ['IGNORE'] };
      if (!allowed[x.type].includes(b.decision)) throw unprocessable('DECISION', `Décision impossible pour un écart « ${x.type.toLowerCase()} »`);

      if (b.decision !== 'IGNORE') await this.apply(tx, user, inv.numero, x, b.decision, b.motif);
      await tx.query('UPDATE inventaire_ecart SET decision = $2, motif = $3, decide_par = $4, decide_le = now() WHERE id = $1', [x.id, b.decision, b.motif, user.id]);
      const left = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM inventaire_ecart WHERE inventaire_id = $1 AND decision IS NULL', [inv.id])).rows[0]!.n;
      let statut = inv.statut;
      if (!left && inv.statut === 'A_ARBITRER') {
        statut = 'CLOS';
        await tx.query(`UPDATE inventaire SET statut = 'CLOS', clos_le = now() WHERE id = $1`, [inv.id]);
      }
      await this.audit.record(tx, user, {
        action: 'INVENTAIRE_ARBITRAGE',
        objet: 'inventaire',
        objetId: inv.id,
        apres: { ecart: x.id, type: x.type, articleId: x.article_id, decision: b.decision },
        motif: b.motif,
      });
      return { id: x.id, decision: b.decision, restants: left, statut };
    });
  }

  @Post(':id/annuler')
  @RequirePermission('warehouse.manage')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const { motif } = z.object({ motif: z.string().trim().min(3).max(500) }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const inv = (await tx.query<{ id: string; statut: string }>('SELECT id, statut FROM inventaire WHERE id = $1 FOR UPDATE', [uuid.parse(id)])).rows[0];
      if (!inv) throw notFound('Inventaire');
      if (inv.statut !== 'EN_COURS') throw conflict('INVENTAIRE_NON_ANNULABLE', 'Seul un inventaire en cours de comptage peut être annulé');
      await tx.query(`UPDATE inventaire SET statut = 'ANNULE', clos_le = now() WHERE id = $1`, [inv.id]);
      await tx.query(
        `UPDATE mission SET statut = 'ANNULEE' WHERE id IN (SELECT mission_id FROM inventaire_comptage WHERE inventaire_id = $1) AND statut <> 'TERMINEE'`,
        [inv.id],
      );
      await this.audit.record(tx, user, { action: 'INVENTAIRE_ANNULE', objet: 'inventaire', objetId: inv.id, motif });
      return { id: inv.id, statut: 'ANNULE' };
    });
  }

  private async apply(tx: Tx, user: AuthUser, numero: string, x: EcartRow, decision: 'CORRIGE' | 'PERDU', motif: string) {
    const a = (
      await tx.query<{ id: string; entreprise_id: string; statut: ArticleStatus; emplacement_courant_id: string | null; um_courante_id: string | null }>(
        'SELECT id, entreprise_id, statut, emplacement_courant_id, um_courante_id FROM article WHERE id = $1 FOR UPDATE',
        [x.article_id],
      )
    ).rows[0];
    if (!a) throw notFound('Article');
    let next: { statut: ArticleStatus; emplacementId: string | null };
    if (decision === 'PERDU') {
      // l'article a pu être retrouvé ou sortir depuis le comptage : on ne corrige pas sur une information périmée
      if (a.emplacement_courant_id !== x.emplacement_id || !['EN_STOCK', 'RESERVE'].includes(a.statut)) {
        throw conflict('STOCK_A_CHANGE', 'L’article a bougé depuis le comptage : vérifiez sa fiche avant de le déclarer perdu');
      }
      next = { statut: 'PERDU', emplacementId: null };
    } else {
      if (!['EN_STOCK', 'RESERVE', 'PERDU'].includes(a.statut)) throw conflict('STATUT', `Article ${a.statut} : il n’est pas en stock, corrigez-le depuis sa fiche`);
      if (a.emplacement_courant_id === x.emplacement_id) throw conflict('DEJA_CORRIGE', 'L’article est déjà à cet emplacement');
      next = { statut: a.statut === 'PERDU' ? 'EN_STOCK' : a.statut, emplacementId: x.emplacement_id };
    }
    const at = new Date();
    await tx.query(
      `INSERT INTO mouvement (id, tenant_id, article_id, um_id, type, de_emplacement_id, vers_emplacement_id, statut_avant, statut_apres,
                              auteur_id, appareil_id, horodatage_terminal, motif)
       VALUES ($1,$2,$3,$4,'AJUSTEMENT',$5,$6,$7,$8,$9,'back-office',$10,$11)`,
      [
        uuidv7(), user.tenantId, a.id, a.um_courante_id, a.emplacement_courant_id, next.emplacementId, a.statut, next.statut, user.id, at,
        `Inventaire ${numero} : ${decision === 'PERDU' ? 'manquant déclaré perdu' : 'emplacement corrigé'} : ${motif}`.slice(0, 600),
      ],
    );
    await tx.query(
      `UPDATE article SET statut = $2, emplacement_courant_id = $3, um_courante_id = NULL, dernier_mouvement_le = $4, dernier_mouvement_terminal = $4 WHERE id = $1`,
      [a.id, next.statut, next.emplacementId, at],
    );
    if (a.um_courante_id) {
      await tx.query(
        `UPDATE unite_manutention SET actif = false, emplacement_courant_id = NULL WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM article WHERE um_courante_id = $1)`,
        [a.um_courante_id],
      );
    }
    await this.audit.record(tx, user, {
      action: decision === 'PERDU' ? 'STOCK_PERDU' : 'STOCK_DEPLACER',
      objet: 'article',
      objetId: a.id,
      entrepriseId: a.entreprise_id,
      avant: { statut: a.statut, emplacementId: a.emplacement_courant_id },
      apres: next,
      motif: `Inventaire ${numero} : ${motif}`,
    });
  }
}

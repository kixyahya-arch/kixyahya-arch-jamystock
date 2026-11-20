import { Controller, Get, Inject } from '@nestjs/common';
import { computeClientSurface, gaugeLevel, isClientRole, type SurfaceItem } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { forbidden } from '../common/errors.js';
import { FilesService } from '../files/files.service.js';

/** Statuts où le bien occupe physiquement une place au dépôt (et compte donc dans la surface). */
const PRESENT = `('EN_STOCK','RESERVE','EN_PREPARATION')`;

/**
 * Espace Client : contexte de l'utilisateur (entreprise, projets, filtres) et jauge m² en temps réel (ADM-01).
 * La jauge utilise exactement le calcul de la facturation (RG-M2-01 à 04) sur l'état du moment ;
 * la facture, elle, se fonde sur les instantanés quotidiens (FAC-02).
 */
@Controller('me')
export class ClientController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  private clientOnly(user: AuthUser) {
    if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
  }

  @Get('context')
  @RequirePermission('inventory.read')
  context(@CurrentUser() user: AuthUser) {
    this.clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = await tx.query(`SELECT id, nom, type FROM entreprise WHERE id = $1`, [user.entrepriseId]);
      const projets = await tx.query(`SELECT id, nom, statut FROM projet ORDER BY nom`);
      const categories = await tx.query(`SELECT DISTINCT c.id, c.nom FROM categorie c JOIN article a ON a.categorie_id = c.id ORDER BY c.nom`);
      const depots = await tx.query(
        `SELECT DISTINCT d.id, d.nom FROM depot d JOIN zone z ON z.depot_id = d.id JOIN emplacement em ON em.zone_id = z.id
           JOIN article a ON a.emplacement_courant_id = em.id ORDER BY d.nom`,
      );
      return { entreprise: e.rows[0], projets: projets.rows, categories: categories.rows, depots: depots.rows };
    });
  }

  @Get('surface')
  @RequirePermission('inventory.read')
  surface(@CurrentUser() user: AuthUser) {
    this.clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => liveSurface(tx, user.entrepriseId!, user.role !== 'B2B_USER'));
  }

  /**
   * INV-04 : vue « Projets ». Pour chaque projet visible : biens au dépôt et sur site, m² occupés, dernière activité
   * et une photo de couverture (le bien photographié le plus récemment). Un B2B Utilisateur ne voit que ses projets (RLS).
   */
  @Get('projets')
  @RequirePermission('inventory.read')
  projects(@CurrentUser() user: AuthUser) {
    this.clientOnly(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const surface = await liveSurface(tx, user.entrepriseId!, user.role !== 'B2B_USER');
      const r = await tx.query<{ id: string; nom: string; statut: string; au_depot: number; sur_site: number; derniere: string | null; photo: string | null }>(
        `SELECT p.id, p.nom, p.statut,
                count(a.id) FILTER (WHERE a.statut IN ${PRESENT})::int AS au_depot,
                count(a.id) FILTER (WHERE a.statut = 'RESTITUE')::int AS sur_site,
                max(a.dernier_mouvement_le) AS derniere,
                (SELECT ph.id FROM photo ph JOIN article a2 ON a2.id = ph.article_id
                  WHERE a2.projet_id = p.id AND ph.televersee AND a2.statut NOT IN ('PERDU','DETRUIT')
                  ORDER BY ph.prise_le DESC LIMIT 1) AS photo
           FROM projet p LEFT JOIN article a ON a.projet_id = p.id AND a.statut NOT IN ('PERDU','DETRUIT')
          WHERE p.entreprise_id = $1
          GROUP BY p.id ORDER BY max(a.dernier_mouvement_le) DESC NULLS LAST, p.nom`,
        [user.entrepriseId],
      );
      return r.rows.map((p) => ({
        id: p.id,
        nom: p.nom,
        statut: p.statut,
        auDepot: p.au_depot,
        surSite: p.sur_site,
        m2: surface.parProjet.find((x) => x.projetId === p.id)?.m2 ?? 0,
        derniereActivite: p.derniere,
        couverture: p.photo ? this.files.photoUrl(user.tenantId, p.photo, 't') : null,
      }));
    });
  }

  /**
   * ADM-01 : courbe d'évolution sur 12 mois, à partir des instantanés quotidiens de la facturation (FAC-02) :
   * moyenne des m² par mois et pic du mois. Un B2B Utilisateur ne voit que ses projets (RLS).
   */
  @Get('surface/historique')
  @RequirePermission('inventory.read')
  history(@CurrentUser() user: AuthUser) {
    this.clientOnly(user);
    const projetsSeulement = user.role === 'B2B_USER';
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<{ mois: string; moyenne: number; pic: number }>(
        `WITH jours AS (
           SELECT i.date, sum(i.m2_occupes)::float AS m2
             FROM instantane_occupation i
            WHERE i.entreprise_id = $1 AND i.date >= date_trunc('month', current_date) - interval '11 months'
              AND ($2::boolean IS FALSE OR i.projet_id IN (SELECT id FROM projet))
            GROUP BY i.date)
         SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS mois, round(avg(m2)::numeric, 1)::float AS moyenne, round(max(m2)::numeric, 1)::float AS pic
           FROM jours GROUP BY 1 ORDER BY 1`,
        [user.entrepriseId, projetsSeulement],
      );
      // 12 mois pleins, les mois sans instantané valent null (avant l'arrivée du client)
      const out: { mois: string; moyenne: number | null; pic: number | null }[] = [];
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const mois = d.toISOString().slice(0, 7);
        const row = r.rows.find((x) => x.mois === mois);
        out.push({ mois, moyenne: row?.moyenne ?? null, pic: row?.pic ?? null });
      }
      return out;
    });
  }
}

interface LocRow {
  emplacement_id: string;
  type: 'RACK' | 'ETAGERE' | 'SOL';
  surface_m2: number;
  niveaux: number;
  longueur_m: number | null;
  largeur_m: number | null;
  empilable: boolean;
  projet_id: string | null;
  depot_id?: string | null;
}

/**
 * Surface en temps réel d'une entreprise. companyWide = false pour un B2B_USER : seuls ses projets (RLS),
 * sans UM ni emplacement dédié ni forfait. Le Back-Office l'appelle pour chaque client (personnel : RLS ouverte).
 */
export async function liveSurface(tx: Tx, entrepriseId: string, companyWide = true) {
  const forfait = companyWide
    ? (
        await tx.query<{ m2_inclus: number; coefficient_degagement: number; m2_minimum: number; mode_surface: string }>(
          `SELECT m2_inclus, coefficient_degagement, m2_minimum, mode_surface FROM forfait
            WHERE entreprise_id = $1 AND statut = 'ACTIF' AND date_debut <= current_date AND (date_fin IS NULL OR date_fin >= current_date)
            ORDER BY version DESC LIMIT 1`,
          [entrepriseId],
        )
      ).rows[0]
    : undefined;

  // Articles libres (hors UM) visibles par l'utilisateur (RLS), rangés en zone de stockage
  const articles = await tx.query<LocRow>(
    `SELECT em.id AS emplacement_id, em.type, em.surface_m2, em.niveaux, a.longueur_m, a.largeur_m, a.empilable, a.projet_id, z.depot_id
       FROM article a JOIN emplacement em ON em.id = a.emplacement_courant_id JOIN zone z ON z.id = em.zone_id
      WHERE a.statut IN ${PRESENT} AND a.um_courante_id IS NULL AND z.type = 'STOCKAGE' AND a.entreprise_id = $1`,
    [entrepriseId],
  );
  // UM du client : une UM compte pour son empreinte, quel que soit son contenu (RG-M2-02)
  const ums = companyWide
    ? await tx.query<LocRow>(
        `SELECT em.id AS emplacement_id, em.type, em.surface_m2, em.niveaux, u.longueur_m, u.largeur_m, u.empilable, NULL::uuid AS projet_id, z.depot_id
           FROM unite_manutention u JOIN emplacement em ON em.id = u.emplacement_courant_id JOIN zone z ON z.id = em.zone_id
          WHERE u.entreprise_id = $1 AND u.actif AND z.type = 'STOCKAGE'
            AND EXISTS (SELECT 1 FROM article a WHERE a.um_courante_id = u.id AND a.statut IN ${PRESENT})`,
        [entrepriseId],
      )
    : { rows: [] as LocRow[] };
  const dedicated = companyWide
    ? (await tx.query<{ id: string; surface_m2: number }>(`SELECT id, surface_m2 FROM emplacement WHERE dedie_entreprise_id = $1 AND statut = 'ACTIF'`, [entrepriseId])).rows
    : [];
  const nbArticles = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM article WHERE statut IN ${PRESENT} AND entreprise_id = $1`, [entrepriseId])).rows[0]!.n;
  // biens repris d'un ancien logiciel sans dimensions, ou pas encore rangés en zone de stockage : leur surface reste à mesurer
  const aMesurer = (
    await tx.query<{ sans_dim: number; non_ranges: number }>(
      `SELECT count(*) FILTER (WHERE coalesce(a.longueur_m, 0) = 0 OR coalesce(a.largeur_m, 0) = 0)::int AS sans_dim,
              count(*) FILTER (WHERE z.type IS DISTINCT FROM 'STOCKAGE')::int AS non_ranges
         FROM article a LEFT JOIN emplacement em ON em.id = a.emplacement_courant_id LEFT JOIN zone z ON z.id = em.zone_id
        WHERE a.statut IN ${PRESENT} AND a.entreprise_id = $1 AND a.um_courante_id IS NULL`,
      [entrepriseId],
    )
  ).rows[0]!;

  const toItem = (r: LocRow): SurfaceItem => ({
    lengthM: r.longueur_m ?? 0,
    widthM: r.largeur_m ?? 0,
    stackable: r.empilable,
    location: { id: r.emplacement_id, type: r.type, surfaceM2: r.surface_m2, levels: r.niveaux },
  });
  const k = forfait?.coefficient_degagement;
  const total = computeClientSurface({
    clearanceCoefficient: k,
    minimumM2: forfait?.m2_minimum,
    dedicatedLocations: dedicated.map((d) => ({ id: d.id, surfaceM2: d.surface_m2 })),
    items: [...articles.rows, ...ums.rows].map(toItem),
  });

  // Ventilation par projet (INV-04), articles libres seulement : une UM ou un box ne sont pas rattachés à un projet
  const projets = await tx.query<{ id: string; nom: string }>(`SELECT id, nom FROM projet WHERE entreprise_id = $1 ORDER BY nom`, [entrepriseId]);
  const parProjet = projets.rows
    .map((p) => {
      const rows = articles.rows.filter((r) => r.projet_id === p.id);
      return { projetId: p.id, nom: p.nom, nbArticles: rows.length, m2: computeClientSurface({ clearanceCoefficient: k, dedicatedLocations: [], items: rows.map(toItem) }).rawM2 };
    })
    .filter((p) => p.nbArticles > 0);

  // ADM-01 : détail par dépôt (articles et UM ; les emplacements dédiés sont comptés à part dans le total)
  const depots = await tx.query<{ id: string; nom: string }>(`SELECT id, nom FROM depot ORDER BY nom`);
  const parDepot = depots.rows
    .map((d) => {
      const rows = [...articles.rows, ...ums.rows].filter((r) => r.depot_id === d.id);
      return { depotId: d.id, nom: d.nom, nbArticles: articles.rows.filter((r) => r.depot_id === d.id).length, m2: computeClientSurface({ clearanceCoefficient: k, dedicatedLocations: [], items: rows.map(toItem) }).rawM2 };
    })
    .filter((d) => d.m2 > 0 || d.nbArticles > 0);

  const inclus = forfait?.m2_inclus ?? null;
  return {
    perimetre: companyWide ? 'ENTREPRISE' : 'PROJETS',
    m2Occupes: total.billedM2,
    detail: total,
    nbArticles,
    sansDimensions: aMesurer.sans_dim,
    nonRanges: aMesurer.non_ranges,
    m2Inclus: inclus,
    taux: inclus ? Math.round((total.billedM2 / inclus) * 1000) / 10 : null,
    niveau: inclus ? gaugeLevel(total.billedM2, inclus) : null,
    modeSurface: forfait?.mode_surface ?? null,
    parProjet,
    parDepot,
    calculeLe: new Date().toISOString(),
  };
}

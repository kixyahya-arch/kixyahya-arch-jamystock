import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { formatDocumentNumber, haversineMeters, uuidv7, ETA_DEFAULTS, type GeoPoint } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { TrackingService } from './tracking.service.js';

const uuid = z.string().uuid();
const isoDate = z.string().date();
const parisToday = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

const TourBody = z.object({
  chauffeurId: uuid,
  vehiculeId: uuid.nullish(),
  nom: z.string().trim().max(80).nullish(),
  missionIds: z.array(uuid).min(1).max(40),
});

interface StopRow {
  missionId: string;
  tourneeId: string | null;
  ordre: number | null;
  type: string;
  statut: string;
  numero: string | null;
  client: string | null;
  adresse: string | null;
  geo: GeoPoint | null;
  creneau: string | null;
  volumeM3: number | null;
  poidsKg: number | null;
  arriveLe: string | null;
  assigneA: string | null;
}

const STOP_SELECT = `
  SELECT m.id AS "missionId", m.tournee_id AS "tourneeId", m.ordre, m.type::text AS type, m.statut::text AS statut, c.numero, e.nom AS client,
         c.adresse->>'libelle' AS adresse,
         CASE WHEN jsonb_typeof(c.adresse->'lat') = 'number' THEN json_build_object('lat', (c.adresse->>'lat')::float, 'lng', (c.adresse->>'lng')::float) END AS geo,
         coalesce(c.creneau_confirme, c.creneau_souhaite) AS creneau, c.volume_m3::float AS "volumeM3", c.poids_kg::float AS "poidsKg",
         m.donnees->>'arriveLe' AS "arriveLe", m.assigne_a AS "assigneA"
    FROM mission m JOIN commande c ON c.id = m.commande_id JOIN entreprise e ON e.id = c.entreprise_id`;

/** Kilomètres estimés d'une tournée : dépôt → arrêts dans l'ordre → dépôt, détour routier compris. */
function kmOf(depot: GeoPoint | null, stops: (GeoPoint | null)[]): number | null {
  if (!depot || !stops.length || stops.some((s) => !s)) return null;
  const pts = [depot, ...(stops as GeoPoint[]), depot];
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversineMeters(pts[i - 1]!, pts[i]!);
  return Math.round((m / 1000) * ETA_DEFAULTS.detour * 10) / 10;
}

function tourStatus(stored: string, stops: { statut: string }[]): string {
  if (stored === 'ANNULEE') return 'ANNULEE';
  if (stops.length && stops.every((s) => s.statut === 'TERMINEE' || s.statut === 'ANNULEE')) return 'TERMINEE';
  if (stops.some((s) => s.statut === 'EN_COURS' || s.statut === 'TERMINEE')) return 'EN_COURS';
  return 'PLANIFIEE';
}

/**
 * FLX-04 : tournées. Une tournée est une suite ordonnée d'arrêts (livraisons, collectes) confiée à un chauffeur
 * et un véhicule pour une journée. L'ordre est manuel (optimisation automatique en V2) ; les kilomètres
 * estimés aident à le choisir. Chaque arrêt reste une mission : le terminal les présente dans l'ordre.
 */
@Controller('bo/tournees')
export class ToursController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('mission.assign')
  list(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const day = date ? isoDate.parse(date) : parisToday();
    return this.db.tx(ctxOf(user), async (tx) => {
      const depot = (await tx.query<{ lat: number; lng: number }>(`SELECT latitude AS lat, longitude AS lng FROM depot WHERE latitude IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0] ?? null;
      const tours = (
        await tx.query<{ id: string; numero: string; nom: string | null; statut: string; chauffeurId: string | null; chauffeur: string | null; vehiculeId: string | null; vehicule: string | null; volumeMax: number | null; chargeMax: number | null }>(
          `SELECT t.id, t.numero, t.nom, t.statut, t.chauffeur_id AS "chauffeurId", u.nom AS chauffeur, t.vehicule_id AS "vehiculeId",
                  v.immatriculation AS vehicule, v.volume_m3::float AS "volumeMax", v.charge_utile_kg::float AS "chargeMax"
             FROM tournee t LEFT JOIN utilisateur u ON u.id = t.chauffeur_id LEFT JOIN vehicule v ON v.id = t.vehicule_id
            WHERE t.date = $1 AND t.statut <> 'ANNULEE' ORDER BY t.numero`,
          [day],
        )
      ).rows;
      const stops = (
        await tx.query<StopRow>(
          `${STOP_SELECT}
            WHERE m.type IN ('LIVRAISON', 'COLLECTE') AND m.statut <> 'ANNULEE'
              AND (m.tournee_id = ANY($2::uuid[]) OR (m.tournee_id IS NULL AND (m.debut_prevu AT TIME ZONE 'Europe/Paris')::date = $1 AND m.statut <> 'TERMINEE'))
            ORDER BY m.ordre NULLS LAST, m.debut_prevu, c.numero`,
          [day, tours.map((t) => t.id)],
        )
      ).rows;
      return {
        date: day,
        depot,
        tuiles: this.config.mapTilesUrl,
        tournees: tours.map((t) => {
          const arrets = stops.filter((s) => s.tourneeId === t.id);
          const vol = arrets.reduce((s, a) => s + (a.type === 'LIVRAISON' ? (a.volumeM3 ?? 0) : 0), 0);
          const kg = arrets.reduce((s, a) => s + (a.type === 'LIVRAISON' ? (a.poidsKg ?? 0) : 0), 0);
          const alertes: string[] = [];
          if (t.volumeMax != null && vol > t.volumeMax) alertes.push(`Volume ${vol.toFixed(1)} m³ > capacité ${t.volumeMax} m³`);
          if (t.chargeMax != null && kg > t.chargeMax) alertes.push(`Poids ${Math.round(kg)} kg > charge utile ${t.chargeMax} kg`);
          return {
            ...t,
            statut: tourStatus(t.statut, arrets),
            arrets,
            faits: arrets.filter((a) => a.statut === 'TERMINEE').length,
            volumeM3: Math.round(vol * 10) / 10,
            poidsKg: Math.round(kg),
            kmEstimes: kmOf(depot, arrets.map((a) => a.geo)),
            alertes,
          };
        }),
        disponibles: stops.filter((s) => !s.tourneeId),
        chauffeurs: (await tx.query(`SELECT id, nom FROM utilisateur WHERE role = 'DRIVER' AND statut = 'ACTIF' ORDER BY nom`)).rows,
        vehicules: (await tx.query(`SELECT id, immatriculation, type, volume_m3::float AS "volumeM3", charge_utile_kg::float AS "chargeUtileKg" FROM vehicule WHERE actif ORDER BY volume_m3`)).rows,
      };
    });
  }

  @Post()
  @RequirePermission('mission.assign')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = TourBody.extend({ date: isoDate }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const id = uuidv7();
      const year = Number(b.date.slice(0, 4));
      const seq = (await tx.query<{ n: number }>('SELECT prochain_numero($1, $2, $3) AS n', [user.tenantId, 'TRN', year])).rows[0]!.n;
      const numero = formatDocumentNumber('TRN', year, seq);
      await tx.query(
        `INSERT INTO tournee (id, tenant_id, numero, date, chauffeur_id, vehicule_id, nom, statut, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'PLANIFIEE',$8)`,
        [id, user.tenantId, numero, b.date, b.chauffeurId, b.vehiculeId ?? null, b.nom || null, user.id],
      );
      await this.applyStops(tx, user, { id, date: b.date }, b);
      await this.audit.record(tx, user, { action: 'TOURNEE_CREEE', objet: 'tournee', objetId: id, apres: b });
      return { id, numero };
    });
  }

  /** Remplace chauffeur, véhicule et la liste ordonnée des arrêts. */
  @Put(':id')
  @RequirePermission('mission.assign')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = TourBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const t = (await tx.query<{ id: string; date: string; statut: string; chauffeur_id: string | null }>(`SELECT id, to_char(date, 'YYYY-MM-DD') AS date, statut, chauffeur_id FROM tournee WHERE id = $1 FOR UPDATE`, [uuid.parse(id)])).rows[0];
      if (!t) throw notFound('Tournée');
      if (t.statut === 'ANNULEE') throw conflict('TOURNEE_ANNULEE', 'Tournée annulée');
      await tx.query(`UPDATE tournee SET chauffeur_id = $2, vehicule_id = $3, nom = $4, updated_at = now() WHERE id = $1`, [t.id, b.chauffeurId, b.vehiculeId ?? null, b.nom || null]);
      await this.applyStops(tx, user, t, b);
      await this.audit.record(tx, user, { action: 'TOURNEE_MODIFIEE', objet: 'tournee', objetId: t.id, apres: b });
      return { id: t.id };
    });
  }

  /** Les arrêts quittent la tournée mais restent affectés au chauffeur. */
  @Post(':id/annuler')
  @HttpCode(200)
  @RequirePermission('mission.assign')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const t = (await tx.query<{ id: string }>(`SELECT id FROM tournee WHERE id = $1 AND statut <> 'ANNULEE' FOR UPDATE`, [uuid.parse(id)])).rows[0];
      if (!t) throw notFound('Tournée');
      const started = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM mission WHERE tournee_id = $1 AND statut IN ('EN_COURS', 'TERMINEE')`, [t.id])).rows[0]!.n;
      if (started) throw conflict('TOURNEE_COMMENCEE', 'La tournée a commencé : retirez les arrêts restants un par un');
      await tx.query(`UPDATE mission SET tournee_id = NULL, ordre = NULL WHERE tournee_id = $1`, [t.id]);
      await tx.query(`UPDATE tournee SET statut = 'ANNULEE', updated_at = now() WHERE id = $1`, [t.id]);
      await this.audit.record(tx, user, { action: 'TOURNEE_ANNULEE', objet: 'tournee', objetId: t.id });
      return { id: t.id, statut: 'ANNULEE' };
    });
  }

  private async applyStops(tx: Tx, user: AuthUser, tour: { id: string; date: string; chauffeur_id?: string | null }, b: z.infer<typeof TourBody>) {
    if (new Set(b.missionIds).size !== b.missionIds.length) throw unprocessable('ARRET_EN_DOUBLE', 'Un arrêt figure deux fois');
    const driver = (await tx.query<{ role: string }>(`SELECT role FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`, [b.chauffeurId])).rows[0];
    if (!driver || (driver.role !== 'DRIVER' && driver.role !== 'SUPER_ADMIN')) throw unprocessable('MAUVAISE_RESSOURCE', 'Une tournée se confie à un chauffeur actif');
    if (b.vehiculeId && !(await tx.query(`SELECT 1 FROM vehicule WHERE id = $1 AND actif`, [b.vehiculeId])).rowCount) throw notFound('Véhicule');

    const current = (await tx.query<{ id: string; statut: string }>(`SELECT id, statut::text FROM mission WHERE tournee_id = $1 FOR UPDATE`, [tour.id])).rows;
    const rows = (
      await tx.query<{ id: string; type: string; statut: string; tournee_id: string | null; jour: string; numero: string | null; assigne_a: string | null }>(
        `SELECT m.id, m.type::text, m.statut::text, m.tournee_id, to_char((m.debut_prevu AT TIME ZONE 'Europe/Paris')::date, 'YYYY-MM-DD') AS jour, c.numero, m.assigne_a
           FROM mission m LEFT JOIN commande c ON c.id = m.commande_id WHERE m.id = ANY($1::uuid[]) FOR UPDATE OF m`,
        [b.missionIds],
      )
    ).rows;
    for (const id of b.missionIds) {
      const m = rows.find((r) => r.id === id);
      if (!m) throw notFound('Mission');
      const label = m.numero ?? 'Mission';
      if (!['LIVRAISON', 'COLLECTE'].includes(m.type)) throw unprocessable('ARRET_INVALIDE', `${label} : seules les livraisons et collectes forment une tournée`);
      if (m.tournee_id && m.tournee_id !== tour.id) throw conflict('DEJA_EN_TOURNEE', `${label} est déjà dans une autre tournée`);
      if (m.statut === 'ANNULEE' || m.statut === 'TERMINEE') throw conflict('ARRET_CLOS', `${label} est ${m.statut === 'ANNULEE' ? 'annulée' : 'terminée'}`);
      if (m.jour !== tour.date) throw unprocessable('AUTRE_JOUR', `${label} est prévue le ${m.jour}, pas le ${tour.date}`);
      // un arrêt commencé ne change pas de chauffeur
      if (m.statut === 'EN_COURS' && m.assigne_a !== b.chauffeurId) throw conflict('ARRET_COMMENCE', `${label} est en cours avec un autre chauffeur`);
    }
    for (const c of current.filter((c) => !b.missionIds.includes(c.id))) {
      if (c.statut === 'EN_COURS' || c.statut === 'TERMINEE') throw conflict('ARRET_COMMENCE', 'Un arrêt commencé ou fait ne peut pas quitter la tournée');
      await tx.query(`UPDATE mission SET tournee_id = NULL, ordre = NULL WHERE id = $1`, [c.id]);
    }
    for (const [i, id] of b.missionIds.entries()) {
      await tx.query(
        `UPDATE mission SET tournee_id = $2, ordre = $3, assigne_a = $4, vehicule_id = coalesce($5, vehicule_id),
                statut = CASE WHEN statut = 'A_AFFECTER' THEN 'AFFECTEE'::statut_mission ELSE statut END, updated_at = now()
          WHERE id = $1`,
        [id, tour.id, i + 1, b.chauffeurId, b.vehiculeId ?? null],
      );
    }
    await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1, $2, $3, 'PUSH', 'TOURNEE_AFFECTEE', $4)`, [
      uuidv7(), user.tenantId, b.chauffeurId, JSON.stringify({ tourneeId: tour.id, arrets: b.missionIds.length }),
    ]);
  }
}

/** FLX-05 : où sont les chauffeurs et où en sont leurs missions, pour réagir aux aléas. */
@Controller('bo/flux')
export class FleetMapController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TrackingService) private readonly tracking: TrackingService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('carte')
  @RequirePermission('mission.assign')
  map(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const day = date ? isoDate.parse(date) : parisToday();
    const now = new Date();
    return this.db.tx(ctxOf(user), async (tx) => {
      const stops = (
        await tx.query<StopRow & { tournee: string | null; chauffeurId: string }>(
          `${STOP_SELECT.replace('FROM mission m', ', t.numero AS tournee, m.assigne_a AS "chauffeurId" FROM mission m LEFT JOIN tournee t ON t.id = m.tournee_id')}
            WHERE m.type IN ('LIVRAISON', 'COLLECTE') AND m.statut <> 'ANNULEE' AND m.assigne_a IS NOT NULL
              AND ((m.debut_prevu AT TIME ZONE 'Europe/Paris')::date = $1 OR m.statut = 'EN_COURS')
            ORDER BY m.ordre NULLS LAST, m.debut_prevu`,
          [day],
        )
      ).rows;
      const drivers = (await tx.query<{ id: string; nom: string; telephone: string | null }>(`SELECT id, nom, telephone FROM utilisateur WHERE role = 'DRIVER' AND statut = 'ACTIF' ORDER BY nom`)).rows;
      const chauffeurs = [];
      for (const d of drivers) {
        const mine = stops.filter((s) => s.chauffeurId === d.id);
        // l'arrêt vers lequel il roule, sinon celui où il est arrivé
        const current = mine.filter((s) => s.statut === 'EN_COURS' && !s.arriveLe).pop() ?? mine.find((s) => s.statut === 'EN_COURS');
        // RGPD : la position n'est montrée que pendant une mission en cours
        const state = current ? await this.tracking.state(tx, current.missionId, now) : null;
        chauffeurs.push({
          id: d.id,
          nom: d.nom,
          telephone: d.telephone,
          position: state?.position ?? null,
          enCours: current && state ? { missionId: current.missionId, numero: current.numero, client: current.client, adresse: current.adresse, type: current.type, etape: state.etape, eta: state.eta } : null,
          tournee: mine.find((s) => s.tournee)?.tournee ?? null,
          faits: mine.filter((s) => s.statut === 'TERMINEE').length,
          total: mine.length,
          arrets: mine.map(({ chauffeurId: _c, tourneeId: _t, assigneA: _a, ...s }) => s),
        });
      }
      const depots = (await tx.query(`SELECT id, nom, latitude AS lat, longitude AS lng FROM depot WHERE latitude IS NOT NULL ORDER BY nom`)).rows;
      return { date: day, maintenant: now.toISOString(), tuiles: this.config.mapTilesUrl, depots, chauffeurs };
    });
  }
}

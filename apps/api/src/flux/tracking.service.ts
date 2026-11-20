import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { estimateArrival, type GeoPoint } from '@jamystock/domain';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Tx } from '../db/database.js';
import { BusinessError } from '../common/errors.js';

/** SUI-02 : un lien de suivi vaut 48 h à partir du départ du chauffeur. */
export const SUIVI_TTL_MS = 48 * 3600_000;
/** Au-delà, la position n'est plus montrée comme « en direct ». */
export const POSITION_FRAICHE_MS = 10 * 60_000;

const coords = (a: unknown): GeoPoint | null => {
  const x = a as { lat?: unknown; lng?: unknown } | null;
  return x && typeof x.lat === 'number' && typeof x.lng === 'number' ? { lat: x.lat, lng: x.lng } : null;
};

export type Etape = 'PREVUE' | 'EN_ROUTE' | 'ARRIVE' | 'TERMINEE' | 'ANNULEE';

export interface Suivi {
  missionId: string;
  numero: string | null;
  type: 'LIVRAISON' | 'COLLECTE';
  etape: Etape;
  chauffeur: string | null;
  eta: string | null;
  arretsAvant: number;
  creneau: string | null;
  datePrevue: string | null;
  enRouteLe: string | null;
  arriveLe: string | null;
  termineLe: string | null;
  position: { lat: number; lng: number; at: string; fraiche: boolean } | null;
  destination: { lat: number; lng: number } | null;
  adresse: string | null;
}

/**
 * Lien de suivi public (SUI-02, LIV-02) : sans compte, scellé par HMAC (organisation, mission, échéance).
 * Le lien ne révèle que l'arrêt concerné : étape, prénom du chauffeur, position pendant le trajet, heure estimée.
 */
@Injectable()
export class TrackingService {
  private readonly key: Buffer;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.key = createHmac('sha256', config.jwtSecret).update('jamystock:suivi:v1').digest();
  }

  private sig(tenantId: string, missionId: string, exp: number) {
    return createHmac('sha256', this.key).update(`${tenantId}.${missionId}.${exp}`).digest('base64url');
  }

  token(tenantId: string, missionId: string, from: Date): string {
    const exp = Math.floor((from.getTime() + SUIVI_TTL_MS) / 1000);
    return `${tenantId}.${missionId}.${exp}.${this.sig(tenantId, missionId, exp)}`;
  }

  url(token: string) {
    return `${this.config.publicUrl}/#/suivi/${token}`;
  }

  parse(token: string, now = Date.now()): { tenantId: string; missionId: string; expireLe: Date } {
    const [tenantId, missionId, e, s] = token.split('.');
    const exp = Number(e);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!tenantId || !missionId || !s || !uuidRe.test(tenantId) || !uuidRe.test(missionId) || !Number.isInteger(exp)) {
      throw new BusinessError(404, 'LIEN_INVALIDE', 'Lien de suivi invalide');
    }
    const expected = Buffer.from(this.sig(tenantId, missionId, exp));
    const given = Buffer.from(s);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new BusinessError(404, 'LIEN_INVALIDE', 'Lien de suivi invalide');
    if (exp * 1000 < now) throw new BusinessError(410, 'LIEN_EXPIRE', 'Ce lien de suivi a expiré');
    return { tenantId, missionId, expireLe: new Date(exp * 1000) };
  }

  /** État d'un arrêt et heure d'arrivée estimée, recalculée à chaque appel. */
  async state(tx: Tx, missionId: string, now = new Date()): Promise<Suivi | null> {
    const m = (
      await tx.query<{
        id: string; type: 'LIVRAISON' | 'COLLECTE'; statut: string; assigne_a: string | null; tournee_id: string | null; ordre: number | null;
        debut_prevu: Date | null; debut_reel: Date | null; fin_reelle: Date | null; donnees: Record<string, unknown>;
        numero: string | null; adresse: Record<string, unknown> | null; creneau: string | null; chauffeur: string | null; depot: GeoPoint | null;
      }>(
        `SELECT m.id, m.type::text AS type, m.statut::text AS statut, m.assigne_a, m.tournee_id, m.ordre, m.debut_prevu, m.debut_reel, m.fin_reelle, m.donnees,
                c.numero, c.adresse, coalesce(c.creneau_confirme, c.creneau_souhaite) AS creneau, split_part(u.nom, ' ', 1) AS chauffeur,
                CASE WHEN d.latitude IS NOT NULL THEN json_build_object('lat', d.latitude, 'lng', d.longitude) END AS depot
           FROM mission m JOIN commande c ON c.id = m.commande_id
           LEFT JOIN utilisateur u ON u.id = m.assigne_a
           -- dépôt de départ : celui de la mission ou de la commande, sinon le premier dépôt localisé
           LEFT JOIN LATERAL (SELECT latitude, longitude FROM depot WHERE latitude IS NOT NULL
                               ORDER BY (id = coalesce(m.depot_id, c.depot_id)) DESC NULLS LAST, created_at LIMIT 1) d ON true
          WHERE m.id = $1 AND m.type IN ('LIVRAISON', 'COLLECTE')`,
        [missionId],
      )
    ).rows[0];
    if (!m) return null;
    const d = m.donnees as { enRouteLe?: string; arriveLe?: string };
    const etape: Etape =
      m.statut === 'ANNULEE' ? 'ANNULEE' : m.statut === 'TERMINEE' ? 'TERMINEE' : d.arriveLe ? 'ARRIVE' : m.statut === 'EN_COURS' ? 'EN_ROUTE' : 'PREVUE';
    const destination = coords(m.adresse);

    let position: Suivi['position'] = null;
    let eta: Date | null = null;
    let arretsAvant = 0;
    if (etape === 'EN_ROUTE' && m.assigne_a) {
      const p = (
        await tx.query<{ lat: number; lng: number; horodatage: Date }>(
          `SELECT lat, lng, horodatage FROM position_chauffeur WHERE utilisateur_id = $1 AND horodatage >= $2 ORDER BY horodatage DESC LIMIT 1`,
          [m.assigne_a, m.debut_reel ? new Date(m.debut_reel.getTime() - 60_000) : new Date(now.getTime() - 12 * 3600_000)],
        )
      ).rows[0];
      if (p) position = { lat: p.lat, lng: p.lng, at: p.horodatage.toISOString(), fraiche: now.getTime() - p.horodatage.getTime() <= POSITION_FRAICHE_MS };
      // arrêts de la même tournée encore à faire avant celui-ci
      const before = m.tournee_id
        ? (
            await tx.query<{ adresse: unknown }>(
              `SELECT c.adresse FROM mission x JOIN commande c ON c.id = x.commande_id
                WHERE x.tournee_id = $1 AND x.ordre < $2 AND x.statut NOT IN ('TERMINEE', 'ANNULEE') AND x.donnees->>'arriveLe' IS NULL
                ORDER BY x.ordre`,
              [m.tournee_id, m.ordre ?? 0],
            )
          ).rows.map((r) => coords(r.adresse))
        : [];
      arretsAvant = before.length;
      eta = estimateArrival(now, position ? { lat: position.lat, lng: position.lng } : m.depot, before, destination);
    }
    return {
      missionId: m.id,
      numero: m.numero,
      type: m.type,
      etape,
      chauffeur: m.chauffeur || null,
      eta: eta?.toISOString() ?? null,
      arretsAvant,
      creneau: m.creneau,
      datePrevue: m.debut_prevu?.toISOString() ?? null,
      enRouteLe: d.enRouteLe ?? null,
      arriveLe: d.arriveLe ?? null,
      termineLe: m.fin_reelle?.toISOString() ?? null,
      position: etape === 'EN_ROUTE' ? position : null,
      destination,
      adresse: (m.adresse?.libelle as string | undefined) ?? null,
    };
  }
}

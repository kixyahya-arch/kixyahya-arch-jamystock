/**
 * Calcul de la surface occupée par un client à une date J (§6.1, RG-M2-01 à RG-M2-04).
 *
 * Fonction pure : le worker nocturne charge les données à 23 h 59, appelle computeClientSurface()
 * et écrit le résultat dans instantane_occupation.
 *
 * Hypothèses d'interprétation (à valider avec le client, voir docs/points-ouverts.md) :
 *  - RG-M2-02 rack : un emplacement en rack est facturé (surface au sol / niveaux) × taux d'occupation,
 *    taux = min(1, Σ empreintes / surface de l'emplacement).
 *  - RG-M2-02 empilable au sol : les objets empilables d'un même emplacement partagent sa surface :
 *    min(Σ empreintes × k, surface de l'emplacement).
 */
export type LocationType = 'RACK' | 'ETAGERE' | 'SOL';

export interface SurfaceLocation {
  id: string;
  type: LocationType;
  /** surface au sol de l'emplacement (m²) */
  surfaceM2: number;
  /** nombre de niveaux de la travée (rack / étagère), 1 au sol */
  levels: number;
}

/** Une UM ou un article libre (hors UM). Un article dans une UM ne compte pas : seule l'UM compte. */
export interface SurfaceItem {
  lengthM: number;
  widthM: number;
  stackable: boolean;
  location: SurfaceLocation;
}

export interface SurfaceInput {
  /** coefficient de dégagement k (défaut 1,15) */
  clearanceCoefficient?: number;
  /** minimum facturé S_min (défaut 2 m² en B2C, contrat en B2B) */
  minimumM2?: number;
  /** emplacements dédiés au client (box, zone privative) : facturés à leur surface totale (RG-M2-03) */
  dedicatedLocations: { id: string; surfaceM2: number }[];
  /** UM et articles libres facturables, hors emplacements dédiés et hors zones réception/expédition */
  items: SurfaceItem[];
}

export const DEFAULT_CLEARANCE_COEFFICIENT = 1.15;
export const DEFAULT_B2C_MINIMUM_M2 = 2;

export function roundM2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SurfaceBreakdown {
  dedicatedM2: number;
  floorM2: number;
  rackM2: number;
  rawM2: number;
  billedM2: number;
}

export function computeClientSurface(input: SurfaceInput): SurfaceBreakdown {
  const k = input.clearanceCoefficient ?? DEFAULT_CLEARANCE_COEFFICIENT;
  const min = input.minimumM2 ?? 0;
  const dedicatedIds = new Set(input.dedicatedLocations.map((l) => l.id));

  const dedicatedM2 = input.dedicatedLocations.reduce((s, l) => s + l.surfaceM2, 0);

  let floorM2 = 0;
  const rackFootprints = new Map<string, { loc: SurfaceLocation; footprint: number }>();
  const stackFootprints = new Map<string, { loc: SurfaceLocation; footprint: number }>();

  for (const item of input.items) {
    if (dedicatedIds.has(item.location.id)) continue; // déjà facturé à la surface totale
    const footprint = item.lengthM * item.widthM;
    const loc = item.location;
    if ((loc.type === 'RACK' || loc.type === 'ETAGERE') && loc.surfaceM2 > 0) {
      const acc = rackFootprints.get(loc.id) ?? { loc, footprint: 0 };
      acc.footprint += footprint;
      rackFootprints.set(loc.id, acc);
    } else if (item.stackable && loc.surfaceM2 > 0) {
      const acc = stackFootprints.get(loc.id) ?? { loc, footprint: 0 };
      acc.footprint += footprint;
      stackFootprints.set(loc.id, acc);
    } else {
      floorM2 += footprint * k;
    }
  }

  for (const { loc, footprint } of stackFootprints.values()) {
    floorM2 += Math.min(footprint * k, loc.surfaceM2);
  }

  let rackM2 = 0;
  for (const { loc, footprint } of rackFootprints.values()) {
    const occupancy = Math.min(1, footprint / loc.surfaceM2);
    rackM2 += (loc.surfaceM2 / Math.max(1, loc.levels)) * occupancy;
  }

  const rawM2 = dedicatedM2 + floorM2 + rackM2;
  return {
    dedicatedM2: roundM2(dedicatedM2),
    floorM2: roundM2(floorM2),
    rackM2: roundM2(rackM2),
    rawM2: roundM2(rawM2),
    billedM2: roundM2(Math.max(min, rawM2)),
  };
}

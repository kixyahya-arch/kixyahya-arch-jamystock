/**
 * Règles de planification des commandes (RG-CMD-01 à 03, CMD-04).
 */

/** Dates au format AAAA-MM-JJ, calculées en UTC pour rester indépendantes du fuseau du serveur. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isBusinessDay(d: Date, holidays: ReadonlySet<string>): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(toIsoDate(d));
}

/**
 * RG-CMD-01 : première date de livraison possible = maintenant + N heures ouvrées
 * (défaut 48 h, soit 2 jours ouvrés). On compte en jours ouvrés entiers :
 * une commande passée un lundi est livrable au plus tôt le jeudi (mardi et mercredi pleins).
 */
export function earliestDeliveryDate(
  orderedAt: Date,
  minBusinessHours = 48,
  holidays: Iterable<string> = [],
): string {
  const hol = new Set(holidays);
  let days = Math.ceil(minBusinessHours / 24);
  const d = new Date(Date.UTC(orderedAt.getUTCFullYear(), orderedAt.getUTCMonth(), orderedAt.getUTCDate()));
  while (days > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d, hol)) days--;
  }
  // le jour de livraison lui-même doit être ouvré
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (!isBusinessDay(d, hol));
  return toIsoDate(d);
}

/** RG-CMD-03 : annulation gratuite jusqu'à 24 h avant le début du créneau. */
export function isLateCancellation(slotStart: Date, now: Date, freeHours = 24): boolean {
  return slotStart.getTime() - now.getTime() < freeHours * 3600_000;
}

export interface VehicleType {
  code: string;
  label: string;
  volumeM3: number;
  payloadKg: number;
}

/** Véhicules par défaut (CMD-04) ; la flotte réelle vient de la table vehicule. */
export const DEFAULT_VEHICLE_TYPES: readonly VehicleType[] = [
  { code: 'VUL12', label: 'VUL 12 m³', volumeM3: 12, payloadKg: 1200 },
  { code: 'VUL20', label: 'VUL 20 m³', volumeM3: 20, payloadKg: 1500 },
  { code: 'PL', label: 'Poids lourd', volumeM3: 50, payloadKg: 10000 },
];

/** Plus petit véhicule qui contient le volume et le poids, ou null s'il faut plusieurs voyages. */
export function suggestVehicle(
  volumeM3: number,
  weightKg = 0,
  types: readonly VehicleType[] = DEFAULT_VEHICLE_TYPES,
): VehicleType | null {
  const sorted = [...types].sort((a, b) => a.volumeM3 - b.volumeM3);
  return sorted.find((t) => t.volumeM3 >= volumeM3 && t.payloadKg >= weightKg) ?? null;
}

export interface Dimensions {
  lengthM: number;
  widthM: number;
  heightM: number;
}

export function volumeM3(items: Dimensions[]): number {
  return Math.round(items.reduce((s, i) => s + i.lengthM * i.widthM * i.heightM, 0) * 1000) / 1000;
}

/** Distance en mètres entre deux points GPS (contrôle « Arrivé » à plus de 500 m, §4.3). */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Hypothèses de l'heure d'arrivée estimée (SUI-02, LIV-02) : trajet urbain, détour routier, temps passé par arrêt. */
export const ETA_DEFAULTS = { vitesseKmh: 30, detour: 1.35, arretMinutes: 20, arrondiMinutes: 5 } as const;

/**
 * Heure d'arrivée estimée chez un client : depuis la dernière position du chauffeur (ou le dépôt),
 * en passant d'abord par les arrêts de la tournée qui le précèdent et ne sont pas encore faits.
 * Arrondie aux 5 minutes ; `null` si une coordonnée manque (adresse non géocodée).
 */
export function estimateArrival(
  now: Date,
  from: GeoPoint | null,
  stopsBefore: (GeoPoint | null)[],
  destination: GeoPoint | null,
  opts: { vitesseKmh?: number; detour?: number; arretMinutes?: number; arrondiMinutes?: number } = {},
): Date | null {
  const o = { ...ETA_DEFAULTS, ...opts };
  if (!from || !destination || stopsBefore.some((s) => !s)) return null;
  const legMinutes = (a: GeoPoint, b: GeoPoint) => ((haversineMeters(a, b) / 1000) * o.detour * 60) / o.vitesseKmh;
  let minutes = 0;
  let at = from;
  for (const s of stopsBefore as GeoPoint[]) {
    minutes += legMinutes(at, s) + o.arretMinutes;
    at = s;
  }
  minutes += legMinutes(at, destination);
  const step = o.arrondiMinutes * 60_000;
  return new Date(Math.ceil((now.getTime() + minutes * 60_000) / step) * step);
}

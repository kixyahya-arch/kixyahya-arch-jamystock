import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export interface Adresse {
  libelle: string;
  codePostal?: string;
  ville?: string;
  lat?: number;
  lng?: number;
  banId?: string;
}

/**
 * Géocodage des adresses de livraison et de collecte, pour l'heure d'arrivée estimée (SUI-02).
 * Base Adresse Nationale (api-adresse.data.gouv.fr, sans clé). Au mieux : en cas d'échec ou de délai,
 * l'adresse est gardée telle quelle et le suivi s'affiche sans estimation.
 */
@Injectable()
export class GeocoderService {
  private readonly log = new Logger('Geocoder');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async complete<T extends Adresse | undefined>(adresse: T): Promise<T> {
    if (!adresse || this.config.geocoder.mode === 'off') return adresse;
    if (typeof adresse.lat === 'number' && typeof adresse.lng === 'number') return adresse;
    try {
      const url = `${this.config.geocoder.baseUrl}/search/?limit=1&q=${encodeURIComponent(adresse.libelle)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return adresse;
      const body = (await res.json()) as { features?: { geometry: { coordinates: [number, number] }; properties: { score: number; id?: string; postcode?: string; city?: string } }[] };
      const f = body.features?.[0];
      // en dessous de 0,5 la BAN propose souvent une autre rue : mieux vaut pas d'estimation qu'une fausse
      if (!f || f.properties.score < 0.5) return adresse;
      const [lng, lat] = f.geometry.coordinates;
      return { ...adresse, lat, lng, banId: adresse.banId ?? f.properties.id, codePostal: adresse.codePostal ?? f.properties.postcode, ville: adresse.ville ?? f.properties.city };
    } catch (e) {
      this.log.warn(`Géocodage impossible : ${(e as Error).message}`);
      return adresse;
    }
  }
}

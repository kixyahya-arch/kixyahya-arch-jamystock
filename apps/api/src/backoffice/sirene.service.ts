import { Inject, Injectable, Logger } from '@nestjs/common';
import { isValidSiret, normalizeSiret } from '@jamystock/domain';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export type SireneResult =
  | { statut: 'TROUVE'; siret: string; siren: string; nom: string; adresse: string | null; actif: boolean; tva: string }
  | { statut: 'INTROUVABLE' | 'INVALIDE' | 'INDISPONIBLE'; siret: string; message: string };

/** Numéro de TVA intracommunautaire français, calculé depuis le SIREN (clé = (12 + 3 × (SIREN mod 97)) mod 97). */
export function tvaFromSiren(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return `FR${String(key).padStart(2, '0')}${siren}`;
}

/**
 * CLI-01 : vérification d'un SIRET auprès du répertoire Sirene de l'INSEE, via l'API publique
 * « Recherche d'entreprises » (recherche-entreprises.api.gouv.fr, sans clé). Au mieux : si le service ne répond pas,
 * l'exploitant est prévenu et peut créer le compte quand même (la clé de contrôle du SIRET reste vérifiée).
 */
@Injectable()
export class SireneService {
  private readonly log = new Logger('Sirene');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async check(raw: string): Promise<SireneResult> {
    const siret = normalizeSiret(raw);
    if (!isValidSiret(siret)) return { statut: 'INVALIDE', siret, message: 'SIRET invalide (14 chiffres, clé de contrôle)' };
    if (this.config.sirene.mode === 'off') return { statut: 'INDISPONIBLE', siret, message: 'Vérification INSEE désactivée' };
    try {
      const res = await fetch(`${this.config.sirene.baseUrl}/search?q=${siret}&page=1&per_page=1`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { statut: 'INDISPONIBLE', siret, message: `Service INSEE indisponible (HTTP ${res.status})` };
      const body = (await res.json()) as {
        results?: {
          siren: string;
          nom_complet: string;
          etat_administratif?: string;
          siege?: { siret: string; adresse?: string; etat_administratif?: string };
          matching_etablissements?: { siret: string; adresse?: string; etat_administratif?: string }[];
        }[];
      };
      const r = body.results?.[0];
      const etab = r && (r.matching_etablissements?.find((e) => e.siret === siret) ?? (r.siege?.siret === siret ? r.siege : undefined));
      if (!r || !etab) return { statut: 'INTROUVABLE', siret, message: 'Ce SIRET est inconnu du répertoire Sirene' };
      return {
        statut: 'TROUVE',
        siret,
        siren: r.siren,
        nom: r.nom_complet,
        adresse: etab.adresse ?? null,
        actif: (etab.etat_administratif ?? r.etat_administratif ?? 'A') === 'A',
        tva: tvaFromSiren(r.siren),
      };
    } catch (e) {
      this.log.warn(`Vérification Sirene impossible : ${(e as Error).message}`);
      return { statut: 'INDISPONIBLE', siret, message: 'Service INSEE injoignable pour le moment' };
    }
  }
}

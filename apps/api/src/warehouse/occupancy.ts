/**
 * Occupation au sol d'un emplacement, même règle que le contrôle de capacité au rangement (§4.1 étape 8) :
 * emprise L × l de chaque article posé seul (moitié s'il est empilable) et emprise de chaque unité de manutention.
 */
export const SHELF_STATUSES = ['EN_STOCK', 'RESERVE', 'EN_PREPARATION'] as const;
const IN_SHELF = `('EN_STOCK','RESERVE','EN_PREPARATION')`;

/** Colonnes « occupe_m2 » et « nb_articles » pour l'emplacement d'alias donné. */
export const usageColumns = (e = 'e') => `
  (coalesce((SELECT sum(coalesce(a.longueur_m * a.largeur_m, 0) * CASE WHEN a.empilable THEN 0.5 ELSE 1 END)
               FROM article a WHERE a.emplacement_courant_id = ${e}.id AND a.um_courante_id IS NULL AND a.statut IN ${IN_SHELF}), 0)
   + coalesce((SELECT sum(u.longueur_m * u.largeur_m) FROM unite_manutention u WHERE u.emplacement_courant_id = ${e}.id AND u.actif), 0))::float AS occupe_m2,
  (SELECT count(*)::int FROM article a WHERE a.emplacement_courant_id = ${e}.id AND a.statut IN ${IN_SHELF}) AS nb_articles`;

export type Fill = 'LIBRE' | 'PARTIEL' | 'PLEIN' | 'INDISPONIBLE';

/** Seuil au-delà duquel un emplacement est « plein » : il reste moins de 10 % de sa surface. */
export const FULL_RATIO = 0.9;

export function fillOf(l: { statut: string; surface_m2: number; occupe_m2: number; nb_articles: number }): Fill {
  if (l.statut !== 'ACTIF') return 'INDISPONIBLE';
  if (l.surface_m2 > 0) {
    const r = l.occupe_m2 / l.surface_m2;
    if (r >= FULL_RATIO) return 'PLEIN';
    return r > 0 || l.nb_articles > 0 ? 'PARTIEL' : 'LIBRE';
  }
  // emplacement sans surface déclarée : on ne sait dire que vide ou occupé
  return l.nb_articles > 0 ? 'PARTIEL' : 'LIBRE';
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

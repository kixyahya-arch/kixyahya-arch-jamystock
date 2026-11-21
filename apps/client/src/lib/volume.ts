/**
 * CMD-06 : assistant de volume par type d'objet. Dimensions moyennes du mobilier de bureaux de vente, bureaux
 * témoins et salons (longueur × largeur × hauteur, en mètres) : le volume sert au choix du véhicule, l'emprise
 * au sol à prévoir la surface au dépôt (RG-AL-03). Les chaises s'empilent par 4 au dépôt.
 */
export interface ObjectType {
  key: string;
  label: string;
  dims: [number, number, number];
  /** nombre d'objets rangés sur la même emprise au sol */
  empile?: number;
}

export const OBJECT_TYPES: ObjectType[] = [
  { key: 'chaise', label: 'Chaise', dims: [0.5, 0.5, 0.9], empile: 4 },
  { key: 'fauteuil', label: 'Fauteuil', dims: [0.8, 0.8, 0.8] },
  { key: 'canape', label: 'Canapé', dims: [2, 0.9, 0.85] },
  { key: 'table-basse', label: 'Table basse', dims: [1, 0.6, 0.45] },
  { key: 'bureau', label: 'Bureau', dims: [1.6, 0.8, 0.75] },
  { key: 'table-reunion', label: 'Table de réunion', dims: [2.2, 1, 0.75] },
  { key: 'comptoir', label: 'Comptoir d’accueil', dims: [2, 0.7, 1.1] },
  { key: 'armoire', label: 'Armoire, rangement', dims: [1, 0.5, 2] },
  { key: 'etagere', label: 'Étagère, bibliothèque', dims: [0.9, 0.4, 1.8] },
  { key: 'plv', label: 'Totem, kakémono (PLV)', dims: [1, 0.4, 2] },
  { key: 'ecran', label: 'Écran, télévision', dims: [1.3, 0.3, 0.8] },
  { key: 'maquette', label: 'Maquette sous vitrine', dims: [1.5, 1, 1.2] },
  { key: 'luminaire', label: 'Luminaire, lampadaire', dims: [0.5, 0.5, 1.7] },
  { key: 'plante', label: 'Plante, jardinière', dims: [0.6, 0.6, 1.5] },
  { key: 'carton', label: 'Carton standard', dims: [0.6, 0.4, 0.4], empile: 3 },
  { key: 'palette', label: 'Palette', dims: [1.2, 0.8, 1.2] },
];

export function estimate(counts: Record<string, number>): { volumeM3: number; m2: number; objets: number } {
  let v = 0;
  let m2 = 0;
  let n = 0;
  for (const t of OBJECT_TYPES) {
    const q = counts[t.key] ?? 0;
    if (q <= 0) continue;
    const [l, w, h] = t.dims;
    v += l * w * h * q;
    m2 += l * w * Math.ceil(q / (t.empile ?? 1));
    n += q;
  }
  return { volumeM3: Math.round(v * 10) / 10, m2: Math.round(m2 * 10) / 10, objets: n };
}

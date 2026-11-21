/**
 * Packs (compte rendu Adam, 21/11) : ensemble nommé de biens pour meubler un logement ou un site, chaque bien
 * rangé dans une pièce. L'ordre des pièces suit la visite d'un logement ; la planche d'aménagement le reprend.
 */
export const PIECES = [
  'Entrée',
  'Séjour',
  'Salon',
  'Salle à manger',
  'Cuisine',
  'Chambre parentale',
  'Chambre',
  'Chambre enfant',
  'Bureau',
  'Salle de bain',
  "Salle d'eau",
  'WC',
  'Dressing',
  'Buanderie',
  'Balcon / terrasse',
  'Jardin',
  'Accueil',
  'Espace de vente',
] as const;

export const PIECE_MAX = 40;

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .trim();

/** Nom de pièce nettoyé (espaces, longueur) ; null si vide. Une pièce connue reprend son écriture de référence. */
export function normalizePiece(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, PIECE_MAX);
  if (!s) return null;
  const known = PIECES.find((p) => fold(p) === fold(s));
  return known ?? s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rang d'une pièce : pièces connues dans l'ordre de visite (« Chambre 2 » suit « Chambre »), puis les autres. */
function rank(piece: string): number {
  const f = fold(piece);
  let best = -1;
  PIECES.forEach((p, i) => {
    const k = fold(p);
    if ((f === k || f.startsWith(`${k} `)) && (best < 0 || k.length > fold(PIECES[best]!).length)) best = i;
  });
  return best < 0 ? PIECES.length : best;
}

/** Trie des noms de pièces ; les biens sans pièce (null) viennent en dernier. */
export function sortPieces<T extends string | null>(pieces: T[]): T[] {
  return [...pieces].sort((a, b) => {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return rank(a) - rank(b) || a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });
  });
}

/** Regroupe des biens par pièce, dans l'ordre de visite. */
export function groupByPiece<T>(items: T[], pieceOf: (t: T) => string | null): { piece: string | null; items: T[] }[] {
  const m = new Map<string | null, T[]>();
  for (const it of items) {
    const p = normalizePiece(pieceOf(it));
    m.set(p, [...(m.get(p) ?? []), it]);
  }
  return sortPieces([...m.keys()]).map((piece) => ({ piece, items: m.get(piece)! }));
}

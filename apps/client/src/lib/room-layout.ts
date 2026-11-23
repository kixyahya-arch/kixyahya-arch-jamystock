/**
 * Disposition automatique des meubles d'une pièce pour la vue 3D : les meubles, du plus encombrant au plus petit,
 * sont rangés en rangées parallèles au mur du fond, avec un passage entre les rangées. Ce n'est pas un plan
 * d'architecte : la vue montre les meubles à leurs vraies dimensions, les uns à côté des autres, pour juger de
 * l'encombrement d'une pièce.
 */

export interface LayoutInput {
  id: string;
  mesures: { longueur: number; largeur: number; hauteur: number | null } | null;
}

export interface PlacedItem {
  id: string;
  /** centre au sol, en mètres ; origine au milieu du mur du fond, z vers l'avant de la pièce */
  x: number;
  z: number;
  /** longueur (le long du mur), profondeur, hauteur */
  w: number;
  d: number;
  h: number;
  /** dimensions inconnues : taille par défaut */
  estimee: boolean;
}

export interface RoomLayout {
  width: number;
  depth: number;
  items: PlacedItem[];
}

const DEFAULT = { w: 0.6, d: 0.6, h: 0.8 };
const MARGIN = 0.3;
const GAP = 0.35;
const WALKWAY = 0.9;
export const MAX_ITEMS = 60;

const clampDim = (v: number | null | undefined, min: number, max: number) => (v && Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, min), max) : null);

export function layoutRoom(input: LayoutInput[]): RoomLayout {
  const items = input.slice(0, MAX_ITEMS).map((a, i) => {
    const w = clampDim(a.mesures?.longueur, 0.1, 8);
    const d = clampDim(a.mesures?.largeur, 0.1, 4);
    const h = clampDim(a.mesures?.hauteur, 0.05, 3.5);
    // la plus grande dimension au sol longe le mur
    const [long, deep] = w && d ? (w >= d ? [w, d] : [d, w]) : [DEFAULT.w, DEFAULT.d];
    return { id: a.id, i, w: long, d: deep, h: h ?? DEFAULT.h, estimee: !(w && d) };
  });
  const area = items.reduce((s, a) => s + a.w * a.d, 0);
  const widest = items.reduce((m, a) => Math.max(m, a.w), 0);
  const width = round(Math.min(Math.max(widest + 2 * MARGIN, Math.sqrt(area * 3.2), 3), 14));
  const sorted = [...items].sort((a, b) => b.w * b.d - a.w * a.d || a.i - b.i);

  const placed: PlacedItem[] = [];
  let x = MARGIN;
  let rowZ = 0.15;
  let rowDepth = 0;
  for (const a of sorted) {
    if (x > MARGIN && x + a.w > width - MARGIN) {
      rowZ += rowDepth + WALKWAY;
      x = MARGIN;
      rowDepth = 0;
    }
    placed.push({ id: a.id, x: round(x + a.w / 2 - width / 2), z: round(rowZ + a.d / 2), w: a.w, d: a.d, h: a.h, estimee: a.estimee });
    x += a.w + GAP;
    rowDepth = Math.max(rowDepth, a.d);
  }
  const depth = round(Math.max(rowZ + rowDepth + 1.2, 3));
  // ordre d'origine (celui de la liste) pour la lecture
  const byId = new Map(placed.map((p) => [p.id, p]));
  return { width, depth, items: items.map((a) => byId.get(a.id)!) };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

import { describe, expect, it } from 'vitest';
import { layoutRoom } from '../src/lib/room-layout';

const m = (longueur: number, largeur: number, hauteur: number | null = 0.8) => ({ longueur, largeur, hauteur });

describe('disposition 3D d’une pièce', () => {
  it('range les meubles sans chevauchement, dans la pièce, à leurs dimensions', () => {
    const items = [
      { id: 'canape', mesures: m(2.2, 0.95, 0.85) },
      { id: 'table', mesures: m(1.6, 0.9, 0.75) },
      { id: 'chaise1', mesures: m(0.5, 0.5, 0.9) },
      { id: 'chaise2', mesures: m(0.5, 0.5, 0.9) },
      { id: 'buffet', mesures: m(0.45, 1.8, 0.9) },
      { id: 'lampe', mesures: null },
    ];
    const r = layoutRoom(items);
    expect(r.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
    for (const a of r.items) {
      expect(a.x - a.w / 2).toBeGreaterThanOrEqual(-r.width / 2);
      expect(a.x + a.w / 2).toBeLessThanOrEqual(r.width / 2);
      expect(a.z - a.d / 2).toBeGreaterThanOrEqual(0);
      expect(a.z + a.d / 2).toBeLessThanOrEqual(r.depth);
    }
    for (const a of r.items)
      for (const b of r.items)
        if (a !== b) {
          const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-9 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2 - 1e-9;
          expect(apart, `${a.id} / ${b.id}`).toBe(true);
        }
    // le buffet est tourné pour longer le mur ; la lampe prend une taille type
    expect(r.items.find((i) => i.id === 'buffet')).toMatchObject({ w: 1.8, d: 0.45, h: 0.9 });
    expect(r.items.find((i) => i.id === 'lampe')).toMatchObject({ estimee: true, w: 0.6, h: 0.8 });
    // le plus encombrant contre le mur du fond
    expect(r.items.find((i) => i.id === 'canape')!.z).toBeCloseTo(0.15 + 0.95 / 2);
  });

  it('agrandit la pièce pour un très grand meuble et reste lisible pour une pièce vide', () => {
    expect(layoutRoom([{ id: 'comptoir', mesures: m(6, 0.8) }]).width).toBeGreaterThanOrEqual(6.6);
    expect(layoutRoom([])).toEqual({ width: 3, depth: 3, items: [] });
  });
});

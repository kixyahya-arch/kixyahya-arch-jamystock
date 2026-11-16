import { describe, expect, it } from 'vitest';
import { computeClientSurface, type SurfaceLocation } from '../src/surface.js';

const sol = (id: string, surfaceM2 = 10): SurfaceLocation => ({ id, type: 'SOL', surfaceM2, levels: 1 });
const rack = (id: string, surfaceM2: number, levels: number): SurfaceLocation => ({ id, type: 'RACK', surfaceM2, levels });

describe('computeClientSurface (RG-M2-01 à 04)', () => {
  it("applique le coefficient de dégagement k = 1,15 à l'empreinte au sol", () => {
    const r = computeClientSurface({
      dedicatedLocations: [],
      items: [{ lengthM: 2, widthM: 1, stackable: false, location: sol('e1') }],
    });
    expect(r.billedM2).toBe(2.3);
  });

  it('facture un emplacement dédié à sa surface totale, quel que soit son remplissage', () => {
    const r = computeClientSurface({
      dedicatedLocations: [{ id: 'box', surfaceM2: 12 }],
      items: [{ lengthM: 1, widthM: 1, stackable: false, location: sol('box', 12) }],
    });
    expect(r.dedicatedM2).toBe(12);
    expect(r.billedM2).toBe(12);
  });

  it('divise la surface rack par le nombre de niveaux, au prorata de l’occupation', () => {
    const r = computeClientSurface({
      dedicatedLocations: [],
      items: [
        // emplacement de 2 m² sur 4 niveaux, occupé à moitié → 2 / 4 × 0,5 = 0,25
        { lengthM: 1, widthM: 1, stackable: false, location: rack('r1', 2, 4) },
      ],
    });
    expect(r.rackM2).toBe(0.25);
  });

  it("plafonne les objets empilables d'un emplacement à sa surface", () => {
    const loc = sol('e2', 3);
    const r = computeClientSurface({
      dedicatedLocations: [],
      items: [
        { lengthM: 1.5, widthM: 1, stackable: true, location: loc },
        { lengthM: 1.5, widthM: 1, stackable: true, location: loc },
        { lengthM: 1.5, widthM: 1, stackable: true, location: loc },
      ],
    });
    expect(r.floorM2).toBe(3);
  });

  it('applique le minimum facturé (2 m² en B2C)', () => {
    const r = computeClientSurface({
      minimumM2: 2,
      dedicatedLocations: [],
      items: [{ lengthM: 0.5, widthM: 0.5, stackable: false, location: sol('e3') }],
    });
    expect(r.rawM2).toBe(0.29);
    expect(r.billedM2).toBe(2);
  });
});

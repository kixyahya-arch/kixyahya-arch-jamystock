import { describe, expect, it } from 'vitest';
import {
  computeMonthlyInvoice,
  creditNoteLines,
  formatDocumentNumber,
  monthlyBilledSurface,
  roundUpHalf,
  totals,
  type ContractTerms,
} from '../src/billing.js';

const bnp: ContractTerms = {
  includedM2: 120,
  monthlyPriceCents: 180_000,
  overagePricePerM2Cents: 1_700,
  includedServices: { LIVRAISON: 2 },
  vatRate: 20,
  surfaceMode: 'MOYENNE',
};

describe('roundUpHalf (RG-M2-05)', () => {
  it('arrondit au 0,5 m² supérieur', () => {
    expect(roundUpHalf(131.2)).toBe(131.5);
    expect(roundUpHalf(131.5)).toBe(131.5);
    expect(roundUpHalf(131.51)).toBe(132);
    expect(roundUpHalf(131)).toBe(131);
  });
  it('ignore le bruit flottant', () => {
    expect(roundUpHalf(0.1 + 0.2 + 130.7)).toBe(131);
  });
});

describe('monthlyBilledSurface', () => {
  it('moyenne journalière par défaut', () => {
    expect(monthlyBilledSurface([100, 110, 120])).toBe(110);
  });
  it('pic du mois en mode alternatif', () => {
    expect(monthlyBilledSurface([100, 110, 120.2], 'PIC')).toBe(120.5);
  });
  it('0 sans instantané', () => {
    expect(monthlyBilledSurface([])).toBe(0);
  });
});

describe('computeMonthlyInvoice (RG-M2-06)', () => {
  it("reproduit l'exemple BNP Construction du cahier des charges : 1 995,50 € HT", () => {
    const daily = Array.from({ length: 31 }, () => 131.2);
    const inv = computeMonthlyInvoice({ terms: bnp, dailyM2: daily, daysInMonth: 31, services: [] });
    expect(inv.billedM2).toBe(131.5);
    expect(inv.lines.map((l) => [l.type, l.totalHtCents])).toEqual([
      ['ABONNEMENT', 180_000],
      ['DEPASSEMENT_M2', 19_550],
    ]);
    expect(inv.totalHtCents).toBe(199_550);
    expect(inv.totalVatCents).toBe(39_910);
    expect(inv.totalTtcCents).toBe(239_460);
  });

  it('pas de dépassement sous les m² inclus', () => {
    const inv = computeMonthlyInvoice({ terms: bnp, dailyM2: Array(30).fill(80), daysInMonth: 30, services: [] });
    expect(inv.lines).toHaveLength(1);
    expect(inv.totalHtCents).toBe(180_000);
  });

  it('consomme le quota de livraisons incluses avant de facturer', () => {
    const inv = computeMonthlyInvoice({
      terms: bnp,
      dailyM2: Array(30).fill(100),
      daysInMonth: 30,
      services: [
        { code: 'LIVRAISON_ZONE1', label: 'Livraison zone 1', quantity: 1, unit: 'livraison', unitPriceCents: 15_000, vatRate: 20, sourceId: 'm1' },
        { code: 'LIVRAISON_ZONE1', label: 'Livraison zone 1', quantity: 1, unit: 'livraison', unitPriceCents: 15_000, vatRate: 20, sourceId: 'm2' },
        { code: 'LIVRAISON_ZONE2', label: 'Livraison zone 2', quantity: 1, unit: 'livraison', unitPriceCents: 22_000, vatRate: 20, sourceId: 'm3' },
        { code: 'MANUTENTION_HEURE', label: 'Manutention', quantity: 1.5, unit: 'h', unitPriceCents: 4_500, vatRate: 20, sourceId: 'm4' },
      ],
    });
    const presta = inv.lines.filter((l) => l.type === 'PRESTATION');
    expect(presta.map((l) => [l.sourceId, l.totalHtCents])).toEqual([
      ['m3', 22_000],
      ['m4', 6_750],
    ]);
    expect(inv.totalHtCents).toBe(180_000 + 22_000 + 6_750);
  });

  it('proratise le premier mois (abonnement et dépassement)', () => {
    const inv = computeMonthlyInvoice({ terms: bnp, dailyM2: Array(15).fill(130), daysInMonth: 30, services: [] });
    const [abo, dep] = inv.lines;
    expect(abo!.totalHtCents).toBe(90_000);
    expect(dep!.quantity).toBe(5);
    expect(dep!.totalHtCents).toBe(8_500);
  });

  it('refuse plus de jours couverts que de jours dans le mois', () => {
    expect(() => computeMonthlyInvoice({ terms: bnp, dailyM2: Array(32).fill(1), daysInMonth: 31, services: [] })).toThrow();
  });
});

describe('totals', () => {
  it('calcule la TVA par taux', () => {
    expect(
      totals([
        { totalHtCents: 1_001, vatRate: 20 },
        { totalHtCents: 1_001, vatRate: 20 },
        { totalHtCents: 1_000, vatRate: 5.5 },
      ]),
    ).toEqual({ totalHtCents: 3_002, totalVatCents: 400 + 55, totalTtcCents: 3_457 });
  });
});

describe('avoirs et numérotation', () => {
  it('avoir partiel en négatif', () => {
    const lines = creditNoteLines(
      [{ type: 'ABONNEMENT', label: 'Forfait', quantity: 1, unit: 'mois', unitPriceCents: 1000, vatRate: 20, totalHtCents: 1000 }],
      0.5,
    );
    expect(lines[0]!.totalHtCents).toBe(-500);
    expect(() => creditNoteLines([], 0)).toThrow();
  });
  it('numéro continu sur 6 chiffres', () => {
    expect(formatDocumentNumber('FA', 2026, 42)).toBe('FA-2026-000042');
  });
});

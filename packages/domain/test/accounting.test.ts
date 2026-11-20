import { describe, expect, it } from 'vitest';
import { clientAccountCode, daysLate, dunningLevelDue, fecEntries, fecFile, FEC_COLUMNS, type FecLine } from '../src/accounting.js';

const client = { code: 'C552100554', nom: 'Horizon' };
const balanced = (lines: FecLine[]) => {
  const by = new Map<string, number>();
  for (const l of lines) by.set(l.EcritureNum, (by.get(l.EcritureNum) ?? 0) + l.Debit - l.Credit);
  return [...by.values()].every((v) => v === 0);
};

describe('relances (FAC-05)', () => {
  it('compte les jours de retard', () => {
    expect(daysLate(null, '2026-03-10')).toBe(0);
    expect(daysLate('2026-03-10', '2026-03-01')).toBe(0);
    expect(daysLate('2026-03-01', '2026-03-31')).toBe(30);
  });
  it('déclenche J+7, J+15, J+30 une seule fois chacun', () => {
    expect(dunningLevelDue('2026-03-01', '2026-03-07', 0)).toBe(0);
    expect(dunningLevelDue('2026-03-01', '2026-03-08', 0)).toBe(1);
    expect(dunningLevelDue('2026-03-01', '2026-03-09', 1)).toBe(0);
    expect(dunningLevelDue('2026-03-01', '2026-03-16', 1)).toBe(2);
    expect(dunningLevelDue('2026-03-01', '2026-03-31', 2)).toBe(3);
    expect(dunningLevelDue('2026-03-01', '2026-06-01', 3)).toBe(0);
  });
  it('ne rattrape pas les paliers manqués', () => {
    expect(dunningLevelDue('2026-03-01', '2026-04-15', 0)).toBe(3);
  });
});

describe('écritures FEC (FAC-06)', () => {
  const facture = { numero: 'FA-2026-000001', type: 'FACTURE' as const, emiseLe: '2026-03-01', client, lignes: [{ tauxTva: 20, totalHtCents: 180_000 }, { tauxTva: 20, totalHtCents: 3_400 }], totalTtcCents: 220_080 };
  const avoir = { numero: 'AV-2026-000001', type: 'AVOIR' as const, emiseLe: '2026-03-05', client, lignes: [{ tauxTva: 20, totalHtCents: -10_000 }], totalTtcCents: -12_000 };
  const paiement = { reference: 'pi_123', date: '2026-03-10', factureNumero: 'FA-2026-000001', client, montantCents: 220_080, moyen: 'CARTE' };

  it('produit des écritures équilibrées', () => {
    const lines = fecEntries([facture, avoir], [paiement]);
    expect(balanced(lines)).toBe(true);
    const fa = lines.filter((l) => l.PieceRef === 'FA-2026-000001');
    expect(fa.map((l) => [l.CompteNum, l.Debit, l.Credit])).toEqual([
      ['411000', 220_080, 0],
      ['706000', 0, 183_400],
      ['445710', 0, 36_680],
    ]);
    expect(fa[0]!.CompAuxNum).toBe('C552100554');
    expect(fa[0]!.EcritureDate).toBe('20260301');
  });
  it('inverse le sens pour un avoir', () => {
    const av = fecEntries([avoir], []);
    expect(av.map((l) => [l.CompteNum, l.Debit, l.Credit])).toEqual([
      ['411000', 0, 12_000],
      ['706000', 10_000, 0],
      ['445710', 2_000, 0],
    ]);
  });
  it('numérote par journal et passe les règlements en banque', () => {
    const lines = fecEntries([avoir, facture], [paiement]);
    expect([...new Set(lines.map((l) => l.EcritureNum))]).toEqual(['VE000001', 'VE000002', 'BQ000001']);
    expect(lines.filter((l) => l.JournalCode === 'BQ').map((l) => [l.CompteNum, l.Debit, l.Credit])).toEqual([
      ['512000', 220_080, 0],
      ['411000', 0, 220_080],
    ]);
  });
  it('absorbe un écart d’arrondi de TVA sur la ligne de TVA', () => {
    const f = { ...facture, lignes: [{ tauxTva: 20, totalHtCents: 333 }, { tauxTva: 10, totalHtCents: 333 }], totalTtcCents: 767 };
    const lines = fecEntries([f], []);
    expect(balanced(lines)).toBe(true);
  });
  it('écrit le fichier normalisé', () => {
    const txt = fecFile(fecEntries([facture], []));
    const rows = txt.split('\r\n');
    expect(rows[0]).toBe(FEC_COLUMNS.join('\t'));
    expect(rows[1]).toContain('\t2200,80\t0,00\t');
    expect(txt.endsWith('\r\n')).toBe(true);
  });
  it('code auxiliaire client', () => {
    expect(clientAccountCode({ siret: '55210055400013', id: 'x' })).toBe('C552100554');
    expect(clientAccountCode({ siret: null, id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' })).toBe('C2E3F4A5B');
  });
});

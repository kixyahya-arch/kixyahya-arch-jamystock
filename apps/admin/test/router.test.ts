import { describe, expect, it } from 'vitest';
import { href, parse } from '../src/lib/router';
import { addDays, parseEuros, previousMonth, roleFor } from '../src/lib/labels';

describe('routes du Back-Office', () => {
  it('aller-retour entre ancre et route', () => {
    for (const r of [
      { name: 'demandes' },
      { name: 'demande', id: 'abc' },
      { name: 'planning' },
      { name: 'planning', date: '2026-11-20' },
      { name: 'clients' },
      { name: 'client', id: 'c1' },
      { name: 'nouveau-client' },
      { name: 'stock' },
      { name: 'facturation' },
      { name: 'facture', id: 'f1' },
      { name: 'tarifs' },
      { name: 'surfaces' },
      { name: 'surfaces', client: 'c1' },
    ] as const) {
      expect(parse(href(r))).toEqual(r);
    }
  });
  it('une date de planning mal formée retombe sur le jour courant', () => {
    expect(parse('#/planning/demain')).toEqual({ name: 'planning' });
  });
});

describe('planning', () => {
  it('le transport va aux chauffeurs, le reste aux opérateurs', () => {
    expect(roleFor('LIVRAISON')).toBe('DRIVER');
    expect(roleFor('COLLECTE')).toBe('DRIVER');
    expect(roleFor('PREPARATION')).toBe('OPERATOR');
    expect(roleFor('RETRAIT')).toBe('OPERATOR');
  });
  it('change de jour sans décalage de fuseau, y compris en fin de mois', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-29', -1)).toBe('2026-03-28');
  });
});

describe('saisie des montants', () => {
  it('accepte la virgule, les espaces et le symbole euro', () => {
    expect(parseEuros('1 800,50 €')).toBe(180050);
    expect(parseEuros('17')).toBe(1700);
    expect(parseEuros('12.5')).toBe(1250);
    expect(parseEuros('douze')).toBeNull();
    expect(parseEuros('1,234')).toBeNull();
  });
  it('mois précédent, y compris en janvier', () => {
    expect(previousMonth('2026-11-16')).toBe('2026-10');
    expect(previousMonth('2027-01-01')).toBe('2026-12');
  });
});

describe('routes des dépôts', () => {
  it('dépôts, dépôt, fiche de correction d’un article', () => {
    expect(parse('#/depots')).toEqual({ name: 'depots' });
    expect(parse('#/depots/abc')).toEqual({ name: 'depot', id: 'abc' });
    expect(parse('#/stock/xyz')).toEqual({ name: 'article', id: 'xyz' });
    expect(href({ name: 'depot', id: 'abc' })).toBe('#/depots/abc');
    expect(href({ name: 'article', id: 'xyz' })).toBe('#/stock/xyz');
  });
});

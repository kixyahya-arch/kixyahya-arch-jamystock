import { describe, expect, it } from 'vitest';
import { href, parse } from '../src/lib/router';
import { addDays, roleFor } from '../src/lib/labels';

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

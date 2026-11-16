import { describe, expect, it } from 'vitest';
import { href, parse, type Route } from '../src/lib/router';
import { dateFr, euros } from '../src/lib/types';

describe('routes de l’Espace Client', () => {
  it('chaque écran a un lien partageable qui le rouvre', () => {
    const routes: Route[] = [
      { name: 'inventaire' },
      { name: 'article', id: '01a1e4f7-fa1a-794e-9cc5-8c4d4c370b8e' },
      { name: 'panier' },
      { name: 'commandes' },
      { name: 'commande', id: '01a1e4f8-c599-7c96-b62c-ee18f9c4400f' },
      { name: 'collecte' },
    ];
    for (const r of routes) expect(parse(href(r))).toEqual(r);
  });

  it('un lien inconnu ramène au stock', () => {
    expect(parse('#/nimporte/quoi')).toEqual({ name: 'inventaire' });
    expect(parse('')).toEqual({ name: 'inventaire' });
  });
});

describe('formats', () => {
  it('montants en euros, dates en français', () => {
    expect(euros(15000).replace(/\s/g, ' ')).toBe('150,00 €');
    expect(dateFr('2026-11-19')).toBe('19 novembre 2026');
    expect(dateFr(null)).toBe('—');
  });
});

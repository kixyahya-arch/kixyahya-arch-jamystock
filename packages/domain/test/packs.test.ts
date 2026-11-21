import { describe, expect, it } from 'vitest';
import { groupByPiece, normalizePiece, sortPieces } from '../src/packs.js';

describe('packs : pièces', () => {
  it('nettoie et reprend l’écriture des pièces connues', () => {
    expect(normalizePiece('  salle   a manger ')).toBe('Salle à manger');
    expect(normalizePiece('SALON')).toBe('Salon');
    expect(normalizePiece('salle d’eau')).toBe("Salle d'eau");
    expect(normalizePiece('mezzanine')).toBe('Mezzanine');
    expect(normalizePiece('   ')).toBeNull();
    expect(normalizePiece('x'.repeat(60))!.length).toBe(40);
  });

  it('ordre de visite, numéros naturels, sans pièce en dernier', () => {
    expect(sortPieces(['Chambre 2', null, 'Mezzanine', 'Salon', 'Chambre 10', 'Entrée', 'Chambre parentale', 'Chambre'])).toEqual([
      'Entrée',
      'Salon',
      'Chambre parentale',
      'Chambre',
      'Chambre 2',
      'Chambre 10',
      'Mezzanine',
      null,
    ]);
  });

  it('regroupe les biens par pièce', () => {
    const g = groupByPiece(
      [
        { n: 'canapé', p: 'salon' },
        { n: 'lit', p: 'Chambre' },
        { n: 'table', p: 'Salon' },
        { n: 'miroir', p: null },
      ],
      (x) => x.p,
    );
    expect(g.map((x) => [x.piece, x.items.map((i) => i.n)])).toEqual([
      ['Salon', ['canapé', 'table']],
      ['Chambre', ['lit']],
      [null, ['miroir']],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseBiens } from '../src/screens/ClientPacks';

describe('étiquettes d’un pack saisies au Back-Office', () => {
  it('une étiquette par ligne, suivie ou non de sa pièce', () => {
    expect(parseBiens('A-000123 ; Salon\nA-000124;Chambre 1\n\n  A-000125  \nA-000126\tSalle à manger\nA-000127, Entrée')).toEqual([
      { qr: 'A-000123', piece: 'Salon' },
      { qr: 'A-000124', piece: 'Chambre 1' },
      { qr: 'A-000125', piece: null },
      { qr: 'A-000126', piece: 'Salle à manger' },
      { qr: 'A-000127', piece: 'Entrée' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { isValidFrenchVat, isValidSiret } from '../src/index.js';

describe('CLI-01 identifiants entreprise', () => {
  it('valide un SIRET par la clé de Luhn, espaces tolérés', () => {
    expect(isValidSiret('732 829 320 00074')).toBe(true);
    expect(isValidSiret('73282932000075')).toBe(false);
    expect(isValidSiret('1234')).toBe(false);
  });
  it('applique l’exception La Poste', () => {
    expect(isValidSiret('35600000000010')).toBe(true); // somme 15
    expect(isValidSiret('35600000000011')).toBe(false);
  });
  it('vérifie la clé de TVA française', () => {
    expect(isValidFrenchVat('FR 44 732829320')).toBe(true);
    expect(isValidFrenchVat('FR45732829320')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { base32Encode, totp, verifyTotp, generateTotpSecret } from '../src/auth/totp.js';

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('reproduit les vecteurs de test de la RFC', () => {
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
  });
  it('tolère un pas de dérive et rejette le reste', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 90_000), now)).toBe(false);
    expect(verifyTotp(s, 'abcdef', now)).toBe(false);
  });
});

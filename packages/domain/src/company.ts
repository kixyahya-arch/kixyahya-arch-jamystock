/**
 * CLI-01 : contrôles de forme des identifiants d'entreprise, avant l'appel à l'API Sirene (prévu).
 * SIRET = SIREN (9 chiffres) + NIC (5 chiffres), clé de Luhn sur les 14 chiffres ;
 * exception La Poste (SIREN 356000000) : somme des chiffres multiple de 5.
 */
export function normalizeSiret(input: string): string {
  return input.replace(/[\s.-]/g, '');
}

export function isValidSiret(input: string): boolean {
  const s = normalizeSiret(input);
  if (!/^\d{14}$/.test(s)) return false;
  if (s.startsWith('356000000')) return [...s].reduce((sum, d) => sum + Number(d), 0) % 5 === 0;
  return luhn(s);
}

/** TVA intracommunautaire française : FR + clé (2 caractères) + SIREN ; la clé numérique se vérifie. */
export function isValidFrenchVat(input: string): boolean {
  const v = input.replace(/\s/g, '').toUpperCase();
  const m = /^FR([0-9A-Z]{2})(\d{9})$/.exec(v);
  if (!m) return false;
  const [, key, siren] = m;
  if (!/^\d{2}$/.test(key!)) return true; // clés alphanumériques (anciens numéros) : contrôle par l'API VIES
  return Number(key) === (12 + 3 * (Number(siren) % 97)) % 97;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

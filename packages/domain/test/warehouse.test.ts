import { describe, expect, it } from 'vitest';
import { averySlots, AVERY_FORMATS, expandLocationPattern, parseLocationCsv, parseRange, zplLabel, zplText } from '../src/warehouse.js';

describe('plages', () => {
  it('lit les écritures usuelles', () => {
    expect(parseRange('4')).toEqual([4]);
    expect(parseRange('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseRange('1 à 3')).toEqual([1, 2, 3]);
    expect(parseRange('1,3,5-6')).toEqual([1, 3, 5, 6]);
    expect(parseRange('5-1')).toBeNull();
    expect(parseRange('abc')).toBeNull();
    expect(parseRange('')).toBeNull();
  });
});

describe('assistant de génération (WMS-02)', () => {
  it('allée 4, niveaux 1 à 5, cases 1 à 20 : 100 emplacements nommés N-B-04-NCC', () => {
    const r = expandLocationPattern({ depotCode: 'n', zoneCode: 'b', allees: '4', niveaux: '1-5', cases: '1-20' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.locations).toHaveLength(100);
    expect(r.locations[0]).toMatchObject({ code: 'N-B-04-101', allee: 4, niveau: 1, case: 1, chemin: ['Allée 4', 'Niveau 1', 'Case 1'] });
    expect(r.locations.at(-1)!.code).toBe('N-B-04-520');
  });

  it('sans niveaux ni allées : emplacements au sol', () => {
    const r = expandLocationPattern({ depotCode: 'N', zoneCode: 'B', cases: '7-8' });
    expect(r.ok && r.locations.map((l) => [l.code, l.chemin.join(' > ')])).toEqual([
      ['N-B-S07', 'Sol 7'],
      ['N-B-S08', 'Sol 8'],
    ]);
  });

  it('gabarit personnalisé et garde-fous', () => {
    const ok = expandLocationPattern({ depotCode: 'N', zoneCode: 'B', allees: '1-2', cases: '1', template: '{Z}{A}.{C}' });
    expect(ok.ok && ok.locations.map((l) => l.code)).toEqual(['B01.01', 'B02.01']);
    expect(expandLocationPattern({ depotCode: 'N', zoneCode: 'B', allees: '1-2', cases: '1', template: '{D}-{C}' })).toMatchObject({ ok: false });
    expect(expandLocationPattern({ depotCode: 'N', zoneCode: 'B', allees: '1-30', niveaux: '1-10', cases: '1-20' })).toMatchObject({ ok: false });
    expect(expandLocationPattern({ depotCode: 'N', zoneCode: 'B', cases: '1', template: '{D}-{Z}' })).toMatchObject({ ok: false });
  });
});

describe('import CSV', () => {
  it('séparateur point-virgule, décimales à virgule, erreurs ligne par ligne', () => {
    const csv = [
      'Zone;Code;Type;Longueur_m;Largeur_m;Hauteur_m;Surface_m2;Charge_max_kg;Statut',
      'B;N-B-05-101;rack;1,2;0,8;1,5;;800;actif',
      'B;N-B-05-102;étagère;;;;0,5;;',
      'B;N-B-05-101;rack;;;;;;',
      'B;n b 05 103;piscine;;;;;;',
      '',
    ].join('\n');
    const r = parseLocationCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ zone: 'B', code: 'N-B-05-101', type: 'RACK', surfaceM2: 0.96, chargeMaxKg: 800, statut: 'ACTIF' });
    expect(r.rows[1]).toMatchObject({ type: 'ETAGERE', surfaceM2: 0.5 });
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
    expect(r.errors[0]!.message).toContain('ligne 2');
  });

  it('en-têtes obligatoires', () => {
    expect(parseLocationCsv('a,b\n1,2').errors[0]!.message).toContain('zone');
  });
});

describe('étiquettes (WMS-03)', () => {
  it('planche Avery : position des étiquettes, saut des cases déjà utilisées, pages suivantes', () => {
    const f = AVERY_FORMATS.find((x) => x.id === 'L7160')!;
    const s = averySlots(f, 3, 20);
    expect(s[0]).toEqual({ page: 0, x: f.margeGauche + 2 * f.pasH, y: f.margeHaut + 6 * f.pasV });
    expect(s[1]).toEqual({ page: 1, x: f.margeGauche, y: f.margeHaut });
  });

  it('ZPL 50 × 25 mm : QR natif, texte sans accents ni caractères de commande', () => {
    const z = zplLabel({ qr: 'https://q.jamystock.fr/E/ABCDEFGHJK', titre: 'N-B-04-112', sousTitre: 'Allée 4 > Niveau 1 > Case 12', depot: 'Dépôt Nord' }, 'ZEBRA_50x25');
    expect(z.startsWith('^XA')).toBe(true);
    expect(z.trim().endsWith('^XZ')).toBe(true);
    expect(z).toContain('^PW400');
    expect(z).toContain('^BQN,2,4^FDMA,https://q.jamystock.fr/E/ABCDEFGHJK^FS');
    expect(z).toContain('Allee 4');
    expect(z).toContain('Depot Nord');
    expect(zplText('a^b~c « d »')).toBe('a-b-c " d "');
    expect(zplLabel({ qr: 'x', titre: 't', depot: 'd' }, 'ZEBRA_100x50')).toContain('^PW800');
  });
});

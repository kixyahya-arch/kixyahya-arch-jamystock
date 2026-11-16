import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  assertCanStore,
  assertTransition,
  canTransition,
  can,
  earliestDeliveryDate,
  evaluateAlerts,
  fingerprint,
  generateQrCode,
  haversineMeters,
  isClientEditable,
  isLateCancellation,
  parseQr,
  qrUrl,
  requiresMfa,
  scopeFor,
  suggestVehicle,
  uuidv7,
  isUuid,
  ORDER_STATUSES,
  ORDER_TYPES,
  allowedTransitions,
  InvalidTransitionError,
  MovementRuleError,
} from '../src/index.js';

describe('machine à états des commandes (§6.4)', () => {
  it('suit le parcours nominal de livraison', () => {
    const path = ['BROUILLON', 'SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE', 'EN_LIVRAISON', 'LIVREE', 'CLOTUREE'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition('LIVRAISON', path[i]!, path[i + 1]!)).toBe(true);
    }
  });
  it('suit la variante retrait et la variante collecte', () => {
    expect(canTransition('RETRAIT', 'PRETE', 'RETIREE')).toBe(true);
    expect(canTransition('RETRAIT', 'PRETE', 'EN_LIVRAISON')).toBe(false);
    expect(canTransition('COLLECTE', 'PLANIFIEE', 'COLLECTEE')).toBe(true);
    expect(canTransition('COLLECTE', 'COLLECTEE', 'STOCKEE')).toBe(true);
  });
  it('refuse toute transition non listée', () => {
    expect(() => assertTransition('LIVRAISON', 'BROUILLON', 'LIVREE')).toThrow(InvalidTransitionError);
    expect(canTransition('LIVRAISON', 'EN_PREPARATION', 'ANNULEE')).toBe(false);
    expect(canTransition('LIVRAISON', 'ECHEC_LIVRAISON', 'PLANIFIEE')).toBe(true);
  });
  it("n'a aucune transition depuis un état terminal", () => {
    for (const t of ORDER_TYPES) {
      expect(allowedTransitions(t, 'CLOTUREE')).toEqual([]);
      expect(allowedTransitions(t, 'ANNULEE')).toEqual([]);
      expect(allowedTransitions(t, 'REFUSEE')).toEqual([]);
    }
    // chaque statut cible existe bien
    for (const t of ORDER_TYPES) for (const s of ORDER_STATUSES) for (const n of allowedTransitions(t, s)) expect(ORDER_STATUSES).toContain(n);
  });
  it('autorise la modification client jusqu’à PLANIFIEE (CMD-07)', () => {
    expect(isClientEditable('SOUMISE')).toBe(true);
    expect(isClientEditable('PLANIFIEE')).toBe(false);
  });
});

describe('mouvements et projection article', () => {
  it('réception → rangement → préparation → chargement → livraison', () => {
    let a = { status: 'ATTENDU' as const, locationId: null, unitId: null } as ReturnType<typeof applyMovement>;
    a = applyMovement(a, { type: 'RECEPTION', toLocationId: 'quai' });
    expect(a.status).toBe('EN_RECEPTION');
    a = applyMovement(a, { type: 'RANGEMENT', toLocationId: 'N-B-04-12' });
    expect(a).toMatchObject({ status: 'EN_STOCK', locationId: 'N-B-04-12' });
    a = applyMovement(a, { type: 'PREPARATION' });
    a = applyMovement(a, { type: 'CHARGEMENT' });
    expect(a).toMatchObject({ status: 'EN_TRANSIT', locationId: null });
    a = applyMovement(a, { type: 'LIVRAISON' });
    expect(a.status).toBe('RESTITUE');
  });
  it('refuse un chargement sans préparation et un rangement sans emplacement', () => {
    expect(() => applyMovement({ status: 'EN_STOCK', locationId: 'x', unitId: null }, { type: 'CHARGEMENT' })).toThrow(MovementRuleError);
    expect(() => applyMovement({ status: 'EN_RECEPTION', locationId: null, unitId: null }, { type: 'RANGEMENT' })).toThrow(MovementRuleError);
  });
  it('un ajustement « perdu » libère emplacement et UM', () => {
    expect(applyMovement({ status: 'EN_STOCK', locationId: 'x', unitId: 'u' }, { type: 'AJUSTEMENT', targetStatus: 'PERDU' })).toEqual({
      status: 'PERDU',
      locationId: null,
      unitId: null,
    });
  });
  it('RG-STK-01 : photo et emplacement actif obligatoires', () => {
    expect(() => assertCanStore(0, true)).toThrow();
    expect(() => assertCanStore(1, false)).toThrow();
    expect(() => assertCanStore(1, true)).not.toThrow();
  });
});

describe('identifiants et QR codes', () => {
  it('génère des UUID v7 triables', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
  });
  it('génère et relit un QR, brut ou en URL', () => {
    const qr = generateQrCode('A');
    expect(qr).toMatch(/^A[2-9A-HJKMNP-TV-Z]{10}$/);
    expect(parseQr(qr)).toEqual({ type: 'A', qr });
    expect(parseQr(qrUrl(qr))).toEqual({ type: 'A', qr });
    expect(parseQr('A0000000000')).toBeNull();
    expect(parseQr('n’importe quoi')).toBeNull();
  });
  it('empreinte canonique indépendante de l’ordre des clés', () => {
    expect(fingerprint({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(fingerprint({ a: [1, { x: 1, y: 2 }], b: 1 }));
  });
});

describe('permissions (§2.2)', () => {
  it('applique la matrice', () => {
    expect(scopeFor('B2B_USER', 'inventory.read')).toBe('P');
    expect(can('B2B_USER', 'order.approve')).toBe(false);
    expect(can('DISPATCHER', 'pricing.manage')).toBe(false);
    expect(can('DISPATCHER', 'mission.assign')).toBe(true);
    expect(can('DRIVER', 'stock.move')).toBe(false);
    expect(requiresMfa('DISPATCHER')).toBe(true);
    expect(requiresMfa('OPERATOR')).toBe(false);
  });
});

describe('planification', () => {
  it('RG-CMD-01 : 48 h ouvrées, week-end et fériés exclus', () => {
    expect(earliestDeliveryDate(new Date('2026-11-16T10:00:00Z'))).toBe('2026-11-19'); // lundi → jeudi
    expect(earliestDeliveryDate(new Date('2026-11-19T10:00:00Z'))).toBe('2026-11-24'); // jeudi → mardi
    expect(earliestDeliveryDate(new Date('2026-12-23T10:00:00Z'), 48, ['2026-12-25'])).toBe('2026-12-29');
  });
  it('RG-CMD-03 : annulation tardive à moins de 24 h', () => {
    const slot = new Date('2026-11-20T08:00:00Z');
    expect(isLateCancellation(slot, new Date('2026-11-19T07:59:00Z'))).toBe(false);
    expect(isLateCancellation(slot, new Date('2026-11-19T08:01:00Z'))).toBe(true);
  });
  it('CMD-04 : suggère le plus petit véhicule suffisant', () => {
    expect(suggestVehicle(8)?.code).toBe('VUL12');
    expect(suggestVehicle(15)?.code).toBe('VUL20');
    expect(suggestVehicle(15, 3000)?.code).toBe('PL');
    expect(suggestVehicle(80)).toBeNull();
  });
  it('mesure une distance GPS', () => {
    const d = haversineMeters({ lat: 48.8566, lng: 2.3522 }, { lat: 48.8606, lng: 2.3376 });
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1300);
  });
});

describe('alertes forfait (§6.2)', () => {
  it('pré-alerte à 90 %', () => {
    expect(evaluateAlerts({ includedM2: 100, history: [80, 91], lastSentAt: {}, today: '2026-11-16' })).toEqual(['RG-AL-01']);
  });
  it('dépassement après 3 jours consécutifs', () => {
    expect(evaluateAlerts({ includedM2: 100, history: [101, 102, 103], lastSentAt: {}, today: '2026-11-16' })).toEqual(['RG-AL-02']);
  });
  it('anti-spam 7 jours', () => {
    const base = { includedM2: 100, history: [95], today: '2026-11-16' };
    expect(evaluateAlerts({ ...base, lastSentAt: { 'RG-AL-01': '2026-11-12' } })).toEqual([]);
    expect(evaluateAlerts({ ...base, lastSentAt: { 'RG-AL-01': '2026-11-09' } })).toEqual(['RG-AL-01']);
  });
  it('sous-utilisation sur 60 jours', () => {
    expect(evaluateAlerts({ includedM2: 100, history: Array(60).fill(50), lastSentAt: {}, today: '2026-11-16' })).toEqual(['RG-AL-04']);
  });
});

describe('contrat de synchronisation terrain', () => {
  it('empreinte de BL stable quel que soit l’ordre de saisie', async () => {
    const { blFingerprint, sortByPath } = await import('../src/sync.js');
    const base = {
      blId: 'b', missionId: 'm', signatureSvg: '<svg/>', signedAt: '2027-01-18T09:00:00Z',
      signataire: { nom: 'A', qualite: 'Chef de chantier' },
    };
    const a = blFingerprint({ ...base, livres: ['x', 'y'], refuses: [], reserves: [{ articleId: 'y', type: 'RAYURE', photoIds: ['p2', 'p1'] }] });
    const b = blFingerprint({ ...base, livres: ['y', 'x'], refuses: [], reserves: [{ articleId: 'y', type: 'RAYURE', commentaire: '', photoIds: ['p1', 'p2'] }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(blFingerprint({ ...base, livres: ['x'], refuses: ['y'], reserves: [] })).not.toBe(a);
    expect(sortByPath([{ chemin: 'N > B > Allée 10' }, { chemin: null }, { chemin: 'N > B > Allée 4' }]).map((x) => x.chemin)).toEqual([
      'N > B > Allée 4', 'N > B > Allée 10', null,
    ]);
  });
});

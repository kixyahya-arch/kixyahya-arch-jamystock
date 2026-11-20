import { describe, expect, it } from 'vitest';
import { estimateArrival, haversineMeters } from '../src/scheduling.js';

const depot = { lat: 48.9362, lng: 2.3574 }; // Saint-Denis
const boulogne = { lat: 48.8355, lng: 2.2413 };
const vincennes = { lat: 48.8474, lng: 2.4392 };
const now = new Date('2026-11-26T08:02:00Z');

describe('heure d’arrivée estimée (SUI-02)', () => {
  it('trajet direct : distance × détour à 30 km/h, arrondie aux 5 minutes', () => {
    const km = haversineMeters(depot, boulogne) / 1000;
    const eta = estimateArrival(now, depot, [], boulogne)!;
    const expectedMin = (km * 1.35 * 60) / 30;
    expect((eta.getTime() - now.getTime()) / 60_000).toBeGreaterThanOrEqual(expectedMin);
    expect((eta.getTime() - now.getTime()) / 60_000).toBeLessThan(expectedMin + 5);
    expect(eta.getUTCMinutes() % 5).toBe(0);
  });

  it('les arrêts précédents de la tournée ajoutent leur trajet et 20 minutes chacun', () => {
    const direct = estimateArrival(now, depot, [], boulogne)!;
    const viaVincennes = estimateArrival(now, depot, [vincennes], boulogne)!;
    expect(viaVincennes.getTime() - direct.getTime()).toBeGreaterThan(20 * 60_000);
  });

  it('sans coordonnées, pas d’estimation', () => {
    expect(estimateArrival(now, null, [], boulogne)).toBeNull();
    expect(estimateArrival(now, depot, [], null)).toBeNull();
    expect(estimateArrival(now, depot, [null], boulogne)).toBeNull();
  });

  it('déjà sur place : l’heure actuelle arrondie', () => {
    expect(estimateArrival(now, boulogne, [], boulogne)!.toISOString()).toBe('2026-11-26T08:05:00.000Z');
  });
});

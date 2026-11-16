import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { seedDemoBilling } from '../src/db/demo-billing.js';
import { BillingScheduler } from '../src/billing/billing.scheduler.js';

/** Historique de facturation de démonstration, produit par le vrai moteur. */
let t: TestContext;
const NOW = new Date('2026-11-16T10:00:00Z');
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${await t.login(email)}`);

beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('facturation de démonstration', () => {
  it('crée deux mois de factures, une seule fois', async () => {
    expect(await seedDemoBilling(OWNER_URL, '.storage', NOW)).toBe(6);
    expect(await seedDemoBilling(OWNER_URL, '.storage', NOW)).toBe(0);
  });

  it('septembre émis et payé, avoir partiel, octobre émis, un brouillon bloqué', async () => {
    const admin = t.data.users.superAdmin.email;
    const items = (await get(admin, '/bo/billing/invoices')).body.items as { numero: string | null; statut: string; type: string; client: string; periodeDebut: string | null; bloquee: boolean }[];
    const by = (n: string) => items.find((i) => i.numero === n)!;
    expect(items.filter((i) => i.periodeDebut === '2026-09-01').map((i) => i.statut)).toEqual(['PAYEE', 'PAYEE', 'PAYEE']);
    expect(by('AV-2026-000001')).toMatchObject({ type: 'AVOIR', client: 'Bâtir Ensemble SARL' });
    expect(['FA-2026-000004', 'FA-2026-000005'].map((n) => by(n).statut)).toEqual(['EMISE', 'EMISE']);
    const draft = items.find((i) => i.statut === 'BROUILLON')!;
    expect(draft).toMatchObject({ client: 'Camille Martin', bloquee: true, periodeDebut: '2026-10-01' });

    const horizonOct = items.find((i) => i.client === 'Promotion Horizon SAS' && i.periodeDebut === '2026-10-01')! as unknown as { id: string };
    const f = (await get(admin, `/bo/billing/invoices/${horizonOct.id}`)).body;
    expect(f.lignes.map((l: { type: string }) => l.type)).toEqual(['ABONNEMENT', 'DEPASSEMENT_M2', 'PRESTATION']);
    expect(f.jours).toHaveLength(31);
  });

  it('les tâches planifiées ne refont rien et l’instantané du jour suit la veille', async () => {
    const r = await t.app.get(BillingScheduler).runFor(t.data.tenantId, NOW);
    expect(r).toEqual({ instantanes: 0, brouillons: null, emises: [] });
  });

  it('le client retrouve ses factures dans ses documents', async () => {
    const docs = (await get(t.data.users.b2bAdmin.email, '/me/documents')).body.items as { type: string }[];
    expect(docs.filter((d) => d.type === 'FACTURE')).toHaveLength(2);
  });
});

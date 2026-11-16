import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { seedDemoOrders } from '../src/db/demo-orders.js';

/** Back-Office : tableau de bord des demandes (FLX-01), planning et affectation (FLX-02, FLX-03), comptes clients (CLI-01). */
let t: TestContext;
const as = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await as(email));
const post = async (email: string, path: string, body: unknown) => t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);

let dispatch: string;
let admin: string;

beforeAll(async () => {
  t = await bootstrap();
  dispatch = t.data.users.dispatcher.email;
  admin = t.data.users.superAdmin.email;
  expect(await seedDemoOrders(OWNER_URL)).toBe(5);
});
afterAll(async () => {
  await t.app.close();
});

describe('demandes de démonstration', () => {
  it('ne sont créées qu’une fois', async () => {
    expect(await seedDemoOrders(OWNER_URL)).toBe(0);
  });
});

describe('tableau de bord des demandes (FLX-01)', () => {
  it('liste toutes les demandes, l’urgente en premier', async () => {
    const res = await get(dispatch, '/bo/orders');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.items[0]).toMatchObject({ urgent: true, type: 'LIVRAISON', client: 'Promotion Horizon SAS' });
    expect(res.body.items.filter((o: { urgent: boolean }) => o.urgent)).toHaveLength(1);
    expect(new Set(res.body.items.map((o: { type: string }) => o.type))).toEqual(new Set(['LIVRAISON', 'RETRAIT', 'COLLECTE']));
  });

  it('filtre par type, client, statut et recherche', async () => {
    expect((await get(dispatch, '/bo/orders?type=COLLECTE')).body.total).toBe(1);
    expect((await get(dispatch, `/bo/orders?client=${t.data.entreprises.particulier}`)).body.items[0].type).toBe('RETRAIT');
    expect((await get(dispatch, '/bo/orders?statut=PLANIFIEE')).body.items[0].missionsAAffecter).toBe(2);
    expect((await get(dispatch, '/bo/orders?q=jardins')).body.total).toBe(1);
  });

  it('les compteurs reflètent la journée', async () => {
    const res = await get(dispatch, '/bo/summary');
    expect(res.body).toMatchObject({ aConfirmer: 4, urgentes: 1, missionsAAffecter: 2 });
  });

  it('un client ou un opérateur n’y a pas accès', async () => {
    expect((await get(t.data.users.b2bAdmin.email, '/bo/orders')).status).toBe(403);
    expect((await get(t.data.users.operator.email, '/bo/orders')).status).toBe(403);
  });
});

describe('fiche, confirmation et planning (FLX-02, FLX-03)', () => {
  let orderId: string;
  let date: string;

  it('la fiche montre le contenu localisé, avec vignettes', async () => {
    const list = await get(dispatch, '/bo/orders?q=jardins');
    orderId = list.body.items[0].id;
    date = list.body.items[0].dateSouhaitee;
    const res = await get(dispatch, `/bo/orders/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.lignes).toHaveLength(2);
    expect(res.body.lignes[0]).toMatchObject({ libelle: expect.stringContaining('Bureau direction'), localisation: expect.stringContaining('Dépôt Nord') });
    expect(res.body.lignes[0].vignette).toMatch(/^\/api\/v1\/files\/photos\//);
    expect(res.body.missions).toEqual([]);
  });

  it('confirmer la date crée la préparation et la livraison à affecter', async () => {
    const res = await post(dispatch, `/orders/${orderId}/plan`, { date, creneau: '13:00-17:00' });
    expect(res.status).toBe(200);
    const fiche = await get(dispatch, `/bo/orders/${orderId}`);
    expect(fiche.body.statut).toBe('PLANIFIEE');
    expect(fiche.body.missions.map((m: { type: string }) => m.type).sort()).toEqual(['LIVRAISON', 'PREPARATION']);
  });

  it('le planning du jour liste missions, chauffeurs, opérateurs et véhicules ; l’affectation contrôle la capacité', async () => {
    const res = await get(dispatch, `/bo/planning?date=${date}`);
    expect(res.status).toBe(200);
    const livraison = res.body.missions.find((m: { type: string; commandeId: string }) => m.type === 'LIVRAISON' && m.commandeId === orderId);
    expect(livraison).toMatchObject({ statut: 'A_AFFECTER', client: 'Promotion Horizon SAS' });
    expect(res.body.ressources.map((r: { role: string }) => r.role).sort()).toEqual(['DRIVER', 'OPERATOR']);
    expect(res.body.vehicules).toHaveLength(2);

    const driver = res.body.ressources.find((r: { role: string }) => r.role === 'DRIVER');
    const operator = res.body.ressources.find((r: { role: string }) => r.role === 'OPERATOR');
    expect((await post(dispatch, `/missions/${livraison.id}/assign`, { assigneA: operator.id })).status).toBe(422);
    const ok = await post(dispatch, `/missions/${livraison.id}/assign`, { assigneA: driver.id, vehiculeId: res.body.vehicules[0].id });
    expect(ok.status).toBe(200);
    const after = await get(dispatch, `/bo/planning?date=${date}`);
    expect(after.body.missions.find((m: { id: string }) => m.id === livraison.id)).toMatchObject({ statut: 'AFFECTEE', assigneNom: 'Chauffeur', vehicule: 'GA-123-AA' });
  });
});

describe('comptes clients (CLI-01)', () => {
  it('liste les clients avec leur surface en temps réel', async () => {
    const res = await get(dispatch, '/bo/clients');
    expect(res.status).toBe(200);
    const horizon = res.body.items.find((c: { nom: string }) => c.nom === 'Promotion Horizon SAS');
    expect(horizon).toMatchObject({ type: 'B2B', m2Inclus: 120, nbProjets: 2 });
    expect(horizon.m2Occupes).toBeGreaterThan(0);
  });

  it('le Super Admin ouvre un compte B2B avec projets et forfait ; un SIRET faux est refusé', async () => {
    const body = {
      type: 'B2B',
      nom: 'Bâtisseurs du Sud',
      siret: '732 829 320 00074',
      tvaIntracom: 'FR44732829320',
      contact: { nom: 'Léa Garnier', email: 'Lea@Batisseurs.test' },
      forfait: { m2Inclus: 50, prixMensuelCents: 75000, prixM2DepassementCents: 1800, livraisonsIncluses: 2 },
      projets: ['Résidence Les Oliviers'],
    };
    expect((await post(admin, '/bo/clients', { ...body, siret: '73282932000075' })).status).toBe(400);
    expect((await post(dispatch, '/bo/clients', body)).status).toBe(403);
    const res = await post(admin, '/bo/clients', body);
    expect(res.status).toBe(201);
    const fiche = await get(admin, `/bo/clients/${res.body.id}`);
    expect(fiche.body).toMatchObject({ siret: '73282932000074', projets: [{ nom: 'Résidence Les Oliviers' }] });
    expect(fiche.body.utilisateurs[0]).toMatchObject({ email: 'lea@batisseurs.test', role: 'B2B_ADMIN', statut: 'INVITE' });
    expect(fiche.body.forfait).toMatchObject({ m2Inclus: 50, prestationsIncluses: { LIVRAISON: 2 } });
    expect((await post(admin, `/bo/clients/${res.body.id}/projets`, { nom: 'Les Pins' })).status).toBe(201);
  });

  it('l’inventaire global se filtre par client et donne le nom du client', async () => {
    const res = await get(dispatch, `/articles?client=${t.data.entreprises.autre}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((a: { client: string }) => a.client === res.body.items[0].client)).toBe(true);
  });
});

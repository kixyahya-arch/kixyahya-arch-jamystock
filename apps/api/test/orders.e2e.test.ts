import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type TestContext } from './setup.js';

let t: TestContext;
const as = async (email: string) => {
  const token = await t.login(email);
  return {
    get: (p: string) => t.http().get(`/api/v1${p}`).set('Authorization', `Bearer ${token}`),
    post: (p: string, body: unknown = {}) => t.http().post(`/api/v1${p}`).set('Authorization', `Bearer ${token}`).send(body as object),
    del: (p: string) => t.http().delete(`/api/v1${p}`).set('Authorization', `Bearer ${token}`),
  };
};

const delivery = {
  type: 'LIVRAISON',
  adresse: { libelle: '3 avenue du Chantier, 92100 Boulogne-Billancourt' },
  contraintesAcces: { etage: 0, accesPL: true, consignes: 'Badge à l’accueil' },
  contactSite: { nom: 'Chef de chantier', telephone: '0600000000' },
  dateSouhaitee: '2027-01-15',
  creneau: '08:00-10:00',
};

beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('parcours panier → commande → planification (§4.2)', () => {
  let orderId: string;

  it('ajoute des articles au panier avec volume et véhicule suggéré (CMD-01, CMD-04)', async () => {
    const client = await as(t.data.users.b2bAdmin.email);
    const res = await client.post('/cart/items', { articleIds: t.data.articles.tilleuls.slice(1, 5), projetId: t.data.projets.tilleuls });
    expect(res.status).toBe(201);
    expect(res.body.statut).toBe('BROUILLON');
    expect(res.body.nbArticles).toBe(4);
    expect(res.body.volumeM3).toBeCloseTo(4 * 1.6 * 0.8 * 0.75, 3);
    expect(res.body.vehiculeSuggere).toBe('VUL 12 m³');
    orderId = res.body.id;
    // ajouter deux fois le même article est sans effet
    const again = await client.post('/cart/items', { articleIds: [t.data.articles.tilleuls[1]], projetId: t.data.projets.tilleuls });
    expect(again.body.nbArticles).toBe(4);
  });

  it('refuse une date sous le délai minimum (RG-CMD-01)', async () => {
    const client = await as(t.data.users.b2bAdmin.email);
    const res = await client.post(`/orders/${orderId}/submit`, { ...delivery, dateSouhaitee: '2026-11-17' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DELAI_MINIMUM');
  });

  it('soumet la commande : numéro, articles réservés et verrouillés', async () => {
    const client = await as(t.data.users.b2bAdmin.email);
    const res = await client.post(`/orders/${orderId}/submit`, delivery);
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('SOUMISE');
    expect(res.body.numero).toMatch(/^CMD-\d{4}-\d{6}$/);
    const art = await client.get(`/articles/${t.data.articles.tilleuls[1]}`);
    expect(art.body.statut).toBe('RESERVE');
  });

  it('un article engagé ne peut pas entrer dans un autre panier', async () => {
    const user = await as(t.data.users.b2bUser.email);
    const res = await user.post('/cart/items', { articleIds: [t.data.articles.tilleuls[1]], projetId: t.data.projets.tilleuls });
    expect(res.status).toBe(409);
  });

  it('le client ne peut pas planifier lui-même', async () => {
    const client = await as(t.data.users.b2bAdmin.email);
    expect((await client.post(`/orders/${orderId}/plan`, { date: '2027-01-15' })).status).toBe(403);
  });

  it('le Dispatcher contre-propose, le client accepte : missions générées', async () => {
    const dispatcher = await as(t.data.users.dispatcher.email);
    const cp = await dispatcher.post(`/orders/${orderId}/counter-propose`, { date: '2027-01-18', message: 'Camion indisponible le 15' });
    expect(cp.status).toBe(200);
    expect(cp.body.dateContreProposee).toBe('2027-01-18');
    const client = await as(t.data.users.b2bAdmin.email);
    const ok = await client.post(`/orders/${orderId}/accept-date`);
    expect(ok.status).toBe(200);
    expect(ok.body.statut).toBe('PLANIFIEE');
    expect(ok.body.dateConfirmee).toBe('2027-01-18');
    expect(ok.body.historique.map((h: { statut: string }) => h.statut)).toEqual(['BROUILLON', 'SOUMISE', 'PLANIFIEE']);
  });

  it('refuse une transition interdite (machine à états côté serveur)', async () => {
    const dispatcher = await as(t.data.users.dispatcher.email);
    const res = await dispatcher.post(`/orders/${orderId}/plan`, { date: '2027-01-19' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('annulation par le client avant J-1 : articles libérés, pas de frais', async () => {
    const client = await as(t.data.users.b2bAdmin.email);
    const res = await client.post(`/orders/${orderId}/cancel`, { motif: 'Planning chantier décalé' });
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('ANNULEE');
    expect(res.body.annulationTardive).toBe(false);
    const art = await client.get(`/articles/${t.data.articles.tilleuls[1]}`);
    expect(art.body.statut).toBe('EN_STOCK');
    expect(art.body.engage).toBeUndefined();
    // de nouveau disponible pour un panier
    const again = await client.post('/cart/items', { articleIds: [t.data.articles.tilleuls[1]], projetId: t.data.projets.tilleuls });
    expect(again.status).toBe(201);
  });
});

describe('validation interne B2B (CMD-05)', () => {
  it('une commande d’un utilisateur sans droit de commander seul attend le B2B Admin', async () => {
    const user = await as(t.data.users.b2bUserNoOrder.email);
    const cart = await user.post('/cart/items', { articleIds: [t.data.articles.tilleuls[10]!], projetId: t.data.projets.tilleuls });
    expect(cart.status).toBe(201);
    const sub = await user.post(`/orders/${cart.body.id}/submit`, delivery);
    expect(sub.body.statut).toBe('EN_ATTENTE_VALIDATION');

    // un utilisateur simple ne peut pas valider
    const other = await as(t.data.users.b2bUser.email);
    expect((await other.post(`/orders/${cart.body.id}/approve`)).status).toBe(403);
    // l'admin d'une autre entreprise ne voit même pas la commande
    const foreign = await as(t.data.users.otherB2bAdmin.email);
    expect((await foreign.post(`/orders/${cart.body.id}/approve`)).status).toBe(404);

    const admin = await as(t.data.users.b2bAdmin.email);
    const ok = await admin.post(`/orders/${cart.body.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.statut).toBe('SOUMISE');
  });

  it('le B2B Utilisateur ne commande pas hors de ses projets', async () => {
    const user = await as(t.data.users.b2bUser.email);
    const res = await user.post('/cart/items', { articleIds: [t.data.articles.jardins[0]], projetId: t.data.projets.jardins });
    expect(res.status).toBe(403);
  });
});

describe('demande de collecte (CMD-06)', () => {
  it('un particulier demande une collecte', async () => {
    const b2c = await as(t.data.users.b2c.email);
    const res = await b2c.post('/collections', {
      adresse: { libelle: '8 rue des Lilas, 75020 Paris' },
      dateSouhaitee: '2027-01-20',
      description: 'Meubles de salon avant travaux',
      volumeEstimeM3: 6,
      lignes: [{ description: 'Canapé 3 places' }, { description: 'Cartons', quantite: 12 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('COLLECTE');
    expect(res.body.statut).toBe('SOUMISE');
    expect(res.body.lignes).toHaveLength(2);
    const dispatcher = await as(t.data.users.dispatcher.email);
    const plan = await dispatcher.post(`/orders/${res.body.id}/plan`, { date: '2027-01-20', creneau: '14:00-16:00' });
    expect(plan.body.statut).toBe('PLANIFIEE');
  });
});

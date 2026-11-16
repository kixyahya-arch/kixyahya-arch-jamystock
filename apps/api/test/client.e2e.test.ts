import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type TestContext } from './setup.js';

/** Espace Client : liens signés vers les photos (§7.3), jauge m² (ADM-01), contexte de filtres (INV-03). */
let t: TestContext;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${await t.login(email)}`);

beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('photos par liens signés', () => {
  let url: string;

  it('l’inventaire renvoie un lien signé, jamais la clé de stockage', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/articles?limite=5');
    expect(res.status).toBe(200);
    url = res.body.items[0].vignette;
    expect(url).toMatch(/^\/api\/v1\/files\/photos\/[0-9a-f-]{36}\/t\?t=.+&e=\d+&s=/);
    expect(JSON.stringify(res.body)).not.toContain('/demo/');
  });

  it('le lien ouvre l’image sans jeton, avec des en-têtes qui empêchent tout script', async () => {
    const res = await t.http().get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('un lien modifié, ou une autre taille avec la même signature, est refusé', async () => {
    expect((await t.http().get(url.replace(/s=./, 's=X'))).status).toBe(403);
    expect((await t.http().get(url.replace('/t?', '/o?'))).status).toBe(403);
    const exp = Number(new URL(url, 'http://x').searchParams.get('e'));
    expect((await t.http().get(url.replace(`e=${exp}`, `e=${exp + 300}`))).status).toBe(403);
  });

  it('la fiche donne vignette, moyenne et originale', async () => {
    const id = t.data.articles.tilleuls[0]!;
    const res = await get(t.data.users.b2bAdmin.email, `/articles/${id}`);
    expect(res.body.photos[0]).toMatchObject({ vignette: expect.stringContaining('/t?'), moyenne: expect.stringContaining('/m?'), originale: expect.stringContaining('/o?') });
    expect(res.body.photos[0].originale).not.toContain('demo');
  });

  it('un autre client n’obtient pas de lien vers mes photos', async () => {
    const id = t.data.articles.tilleuls[0]!;
    expect((await get(t.data.users.otherB2bAdmin.email, `/articles/${id}`)).status).toBe(404);
  });
});

describe('jauge m² en temps réel (ADM-01)', () => {
  it('le B2B Admin voit sa surface face au forfait, ventilée par projet', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/me/surface');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ perimetre: 'ENTREPRISE', m2Inclus: 120, niveau: expect.stringMatching(/OK|ATTENTION|DEPASSEMENT/) });
    expect(res.body.m2Occupes).toBeGreaterThan(0);
    expect(res.body.nbArticles).toBeGreaterThan(0);
    const sum = res.body.parProjet.reduce((s: number, p: { m2: number }) => s + p.m2, 0);
    expect(sum).toBeLessThanOrEqual(res.body.detail.rawM2 + 0.01);
    expect(res.body.parProjet.length).toBeGreaterThanOrEqual(2);
  });

  it('un B2B Utilisateur ne voit que ses projets, sans le forfait de l’entreprise', async () => {
    const res = await get(t.data.users.b2bUser.email, '/me/surface');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ perimetre: 'PROJETS', m2Inclus: null });
    const admin = await get(t.data.users.b2bAdmin.email, '/me/surface');
    expect(res.body.nbArticles).toBeLessThan(admin.body.nbArticles);
  });

  it('le particulier voit son minimum facturé', async () => {
    const res = await get(t.data.users.b2c.email, '/me/surface');
    expect(res.body.m2Inclus).toBe(2);
    expect(res.body.m2Occupes).toBeGreaterThan(0);
  });

  it('réservé aux comptes clients', async () => {
    expect((await get(t.data.users.operator.email, '/me/surface')).status).toBe(403);
  });
});

describe('contexte de l’Espace Client', () => {
  it('donne l’entreprise et les filtres visibles', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/me/context');
    expect(res.body.entreprise.nom).toBe('Promotion Horizon SAS');
    expect(res.body.projets.length).toBe(2);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(res.body.depots).toEqual([expect.objectContaining({ nom: expect.any(String) })]);
    const user = await get(t.data.users.b2bUser.email, '/me/context');
    expect(user.body.projets.length).toBe(1);
  });
});

describe('panier : estimation avant validation (CMD-04)', () => {
  it('donne la date au plus tôt, le prix de la livraison et les livraisons incluses', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/cart');
    expect(res.status).toBe(200);
    expect(res.body.estimation).toMatchObject({
      datePlusTot: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      livraison: { prixHtCents: 15000 },
      livraisonsIncluses: 2,
      retraitHtCents: 0,
    });
  });
});

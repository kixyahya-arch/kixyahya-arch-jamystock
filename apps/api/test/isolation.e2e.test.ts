import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { bootstrap, APP_URL, type TestContext } from './setup.js';

/** §7.3 : tests automatisés d'isolation entre clients (API + RLS). */
let t: TestContext;
const get = async (email: string, path: string) =>
  t.http().get(path).set('Authorization', `Bearer ${await t.login(email)}`);

beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('isolation des inventaires', () => {
  it('le B2B Admin voit tout le stock de son entreprise, et seulement lui', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/api/v1/articles?limite=200');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([...t.data.articles.tilleuls, ...t.data.articles.jardins].sort());
  });

  it('le B2B Utilisateur ne voit que les projets qui lui sont attribués', async () => {
    const res = await get(t.data.users.b2bUser.email, '/api/v1/articles?limite=200');
    expect(res.body.total).toBe(t.data.articles.tilleuls.length);
    const jardins = await get(t.data.users.b2bUser.email, `/api/v1/articles/${t.data.articles.jardins[0]}`);
    expect(jardins.status).toBe(404);
  });

  it('un client ne peut pas lire l’article d’un autre client, même avec son identifiant', async () => {
    const res = await get(t.data.users.b2c.email, `/api/v1/articles/${t.data.articles.tilleuls[0]}`);
    expect(res.status).toBe(404);
    const other = await get(t.data.users.otherB2bAdmin.email, '/api/v1/articles?limite=200');
    expect(other.body.items.map((a: { id: string }) => a.id).sort()).toEqual([...t.data.articles.autre].sort());
  });

  it('le personnel exploitant voit tout le tenant', async () => {
    const res = await get(t.data.users.operator.email, '/api/v1/articles?limite=200');
    const all = Object.values(t.data.articles).flat();
    expect(res.body.total).toBe(all.length);
  });

  it('la fiche article donne photos, fil d’Ariane et historique (INV-02)', async () => {
    const res = await get(t.data.users.b2bAdmin.email, `/api/v1/articles/${t.data.articles.tilleuls[1]}`);
    expect(res.status).toBe(200);
    expect(res.body.localisation).toMatch(/^Dépôt Nord > Zone B > /);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.mouvements.map((m: { type: string }) => m.type)).toEqual(['RANGEMENT', 'RECEPTION']);
  });

  it('la recherche tolère le pluriel : « bureaux » trouve « bureau » (INV-03)', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/api/v1/articles?q=bureaux&limite=200');
    expect(res.body.total).toBeGreaterThanOrEqual(6);
    expect(res.body.items.every((a: { libelle: string }) => /bureau/i.test(a.libelle))).toBe(true);
  });

  it('pagine par lots via un curseur', async () => {
    const p1 = await get(t.data.users.b2bAdmin.email, '/api/v1/articles?limite=5');
    expect(p1.body.items).toHaveLength(5);
    const p2 = await get(t.data.users.b2bAdmin.email, `/api/v1/articles?limite=5&apres=${p1.body.suivant}`);
    expect(p2.body.items).toHaveLength(5);
    const overlap = p2.body.items.filter((a: { id: string }) => p1.body.items.some((b: { id: string }) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });
});

describe('RLS en base, indépendamment de l’API', () => {
  it('sans contexte, le rôle applicatif ne voit aucune ligne client', async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    const r = await c.query('SELECT count(*)::int AS n FROM article');
    expect(r.rows[0].n).toBe(0);
    await c.end();
  });

  it('un client ne peut pas insérer un article pour une autre entreprise', async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.role','B2C',true), set_config('app.entreprise_id',$2,true)`, [
      t.data.tenantId,
      t.data.entreprises.particulier,
    ]);
    await expect(
      c.query(`INSERT INTO article (tenant_id, entreprise_id, qr_code, libelle) VALUES ($1, $2, 'AXXXXXXXXXX', 'intrus')`, [
        t.data.tenantId,
        t.data.entreprises.promoteur,
      ]),
    ).rejects.toThrow(/row-level security/);
    await c.query('ROLLBACK');
    await c.end();
  });

  it('le journal des mouvements est immuable', async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.role','SUPER_ADMIN',true)`, [t.data.tenantId]);
    await expect(c.query(`UPDATE mouvement SET motif = 'x'`)).rejects.toThrow(/immuable/);
    await c.query('ROLLBACK');
    await c.end();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

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

  it('une grande photo est servie en vignette WebP légère (INV-01), fabriquée une fois puis gardée', async () => {
    const id = t.data.articles.jardins[0]!;
    const key = `${t.data.tenantId}/photos/test-inv01/original.jpg`;
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 180, g: 140, b: 90 } } })
      .composite([{ input: Buffer.from('<svg width="4000" height="3000"><circle cx="2000" cy="1500" r="1200" fill="#0a2a43"/></svg>') }])
      .jpeg({ quality: 92 })
      .toBuffer();
    const file = path.resolve(process.env.STORAGE_DIR ?? '.storage', key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, big);
    const c = new pg.Client({ connectionString: OWNER_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
    await c.query(`UPDATE photo SET cle_originale = $2, type_mime = 'image/jpeg', cle_vignette = NULL, cle_moyenne = NULL WHERE article_id = $1`, [id, key]);
    await c.query('COMMIT');
    const fiche = await get(t.data.users.b2bAdmin.email, `/articles/${id}`);
    const thumb = await t.http().get(fiche.body.photos[0].vignette).buffer(true);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(thumb.body.length).toBeLessThan(40 * 1024);
    expect((await sharp(thumb.body).metadata()).width).toBe(480);
    const moyenne = await t.http().get(fiche.body.photos[0].moyenne).buffer(true);
    expect((await sharp(moyenne.body).metadata()).width).toBe(1200);
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
    const row = (await c.query(`SELECT cle_vignette, cle_moyenne FROM photo WHERE article_id = $1`, [id])).rows[0];
    await c.query('COMMIT');
    await c.end();
    expect(row.cle_vignette).toMatch(/-t\.webp$/);
    expect(row.cle_moyenne).toMatch(/-m\.webp$/);
  });

  it('un autre client n’obtient pas de lien vers mes photos', async () => {
    const id = t.data.articles.tilleuls[0]!;
    expect((await get(t.data.users.otherB2bAdmin.email, `/articles/${id}`)).status).toBe(404);
  });
});

describe('vue « Projets » (INV-04)', () => {
  it('chaque projet donne ses biens au dépôt, ses m², sa dernière activité et une photo de couverture', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/me/projets');
    expect(res.status).toBe(200);
    const til = res.body.find((p: { id: string }) => p.id === t.data.projets.tilleuls);
    expect(til).toMatchObject({ nom: 'Stand de vente Résidence Les Tilleuls', auDepot: 14, surSite: 0, derniereActivite: expect.any(String) });
    expect(til.m2).toBeGreaterThan(0);
    expect(til.couverture).toMatch(/^\/api\/v1\/files\/photos\/.+\/t\?/);
    // le B2B Utilisateur ne voit que les projets qui lui sont attribués
    const mine = await get(t.data.users.b2bUser.email, '/me/projets');
    expect(mine.body.map((p: { id: string }) => p.id)).toEqual([t.data.projets.tilleuls]);
  });
});

describe('jauge m² en temps réel (ADM-01)', () => {
  it('donne le détail par dépôt et une courbe de 12 mois tirée des instantanés quotidiens', async () => {
    const s = await get(t.data.users.b2bAdmin.email, '/me/surface');
    expect(s.body.parDepot).toEqual([expect.objectContaining({ nom: 'Dépôt Nord', nbArticles: expect.any(Number), m2: expect.any(Number) })]);
    const c = new pg.Client({ connectionString: OWNER_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
    const ent = (await c.query(`SELECT entreprise_id FROM projet WHERE id = $1`, [t.data.projets.tilleuls])).rows[0].entreprise_id;
    for (const [jours, m2] of [[1, 20], [2, 30], [40, 10]] as const) {
      await c.query(
        `INSERT INTO instantane_occupation (tenant_id, entreprise_id, projet_id, date, m2_occupes, nb_articles) VALUES ($1,$2,$3,current_date - $4::int,$5,3)`,
        [t.data.tenantId, ent, t.data.projets.tilleuls, jours, m2],
      );
    }
    await c.query('COMMIT');
    await c.end();
    const h = await get(t.data.users.b2bAdmin.email, '/me/surface/historique');
    expect(h.status).toBe(200);
    expect(h.body).toHaveLength(12);
    const withData = (h.body as { moyenne: number | null; pic: number | null }[]).filter((m) => m.moyenne !== null);
    expect(withData.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...withData.map((m) => m.pic!))).toBe(30);
    expect((await get(t.data.users.otherB2bAdmin.email, '/me/surface/historique')).body.every((m: { moyenne: unknown }) => m.moyenne === null)).toBe(true);
  });

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

import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Compte rendu Adam (21/11) : packs et planche d'aménagement, activités du client, suppression de photos au Back-Office. */
let t: TestContext;
let owner: pg.Client;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, p: string) => t.http().get(`/api/v1${p}`).set('Authorization', await auth(email));
const post = async (email: string, p: string, body: unknown = {}) => t.http().post(`/api/v1${p}`).set('Authorization', await auth(email)).send(body as object);
const put = async (email: string, p: string, body: unknown = {}) => t.http().put(`/api/v1${p}`).set('Authorization', await auth(email)).send(body as object);
const del = async (email: string, p: string) => t.http().delete(`/api/v1${p}`).set('Authorization', await auth(email));
const pdf = async (email: string, p: string) =>
  t
    .http()
    .get(`/api/v1${p}`)
    .set('Authorization', await auth(email))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

async function sys<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], role = 'SYSTEM') {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', $2, true)`, [t.data.tenantId, role]);
  try {
    const r = await owner.query<T>(sql, params);
    await owner.query('COMMIT');
    return r.rows;
  } catch (e) {
    await owner.query('ROLLBACK');
    throw e;
  }
}
const u = () => t.data.users;

beforeAll(async () => {
  t = await bootstrap();
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('packs composés par le client', () => {
  const tilleuls = () => t.data.articles.tilleuls;
  let pack: string;

  it('crée un pack avec la pièce de chaque bien, et le retrouve rangé par pièce', async () => {
    const [a, b, c] = tilleuls();
    const r = await post(u().b2bAdmin.email, '/me/cart-templates', {
      nom: 'Appartement témoin T3',
      description: 'Meubles du T3 de la résidence',
      projetId: t.data.projets.tilleuls,
      articleIds: [a, b, c],
      pieces: { [a!]: 'chambre 2', [b!]: 'salon', [c!]: '' },
    });
    expect(r.status).toBe(201);
    pack = r.body.id;
    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ nom: 'Appartement témoin T3', description: 'Meubles du T3 de la résidence', nbArticles: 3, modifiable: true });
    // ordre de visite : salon, puis chambre, puis les biens sans pièce
    expect(d.body.pieces.map((p: { piece: string | null; articles: unknown[] }) => [p.piece, p.articles.length])).toEqual([
      ['Salon', 1],
      ['Chambre 2', 1],
      [null, 1],
    ]);
    expect(d.body.articles[0].vignette).toMatch(/^\/api\/v1\/files\/photos\//);
    const list = await get(u().b2bUser.email, '/me/cart-templates');
    expect(list.body.items).toEqual([expect.objectContaining({ id: pack, nbArticles: 3, pieces: 2, supprimable: false })]);
    expect(list.body.items[0].vignettes.length).toBeGreaterThan(0);
  });

  it('un bien d’un autre site ne rejoint pas un pack de site', async () => {
    const r = await put(u().b2bAdmin.email, `/me/cart-templates/${pack}`, { articleIds: [...tilleuls().slice(0, 3), t.data.articles.jardins[0]] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PROJET_DIFFERENT');
  });

  it('se modifie : pièces, nom et biens, par son auteur ou un administrateur', async () => {
    const [a, b, c, d] = tilleuls();
    const r = await put(u().b2bAdmin.email, `/me/cart-templates/${pack}`, { nom: 'T3 témoin', articleIds: [a, b, c, d], pieces: { [c!]: 'Cuisine', [d!]: 'Entrée' } });
    expect(r.status).toBe(200);
    expect(r.body.nom).toBe('T3 témoin');
    expect(r.body.pieces.map((p: { piece: string | null }) => p.piece)).toEqual(['Entrée', 'Salon', 'Cuisine', 'Chambre 2']);
    expect((await put(u().b2bUser.email, `/me/cart-templates/${pack}`, { nom: 'Autre' })).status).toBe(403);
    expect((await get(u().otherB2bAdmin.email, `/me/cart-templates/${pack}`)).status).toBe(404);
  });

  it('se commande en un clic et donne sa planche d’aménagement en PDF, photos comprises', async () => {
    const use = await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/use`);
    expect(use.body).toMatchObject({ ajoutes: 4, indisponibles: [] });
    const f = await pdf(u().b2bUser.email, `/me/cart-templates/${pack}/planche.pdf`);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect(f.headers['content-disposition']).toMatch(/planche-t3-temoin-\d{4}-\d{2}-\d{2}\.pdf/);
    const text = (f.body as Buffer).toString('latin1');
    expect(text).toContain('<pdfaid:part>3</pdfaid:part>');
    expect((f.body as Buffer).toString('utf8')).toContain('Planche d&apos;aménagement T3 témoin');
    expect(text.match(/\/Subtype \/Image/g)?.length).toBe(4);
    for (const id of tilleuls().slice(0, 4)) await del(u().b2bAdmin.email, `/cart/items/${id}?projetId=${t.data.projets.tilleuls}`);
  });
});

describe('packs préparés par le Back-Office pour un client', () => {
  let pack: string;
  it('à partir des étiquettes scannées, avec leur pièce', async () => {
    const qrs = (await sys<{ qr_code: string }>('SELECT qr_code FROM article WHERE id = ANY($1) ORDER BY qr_code', [t.data.articles.jardins.slice(0, 2)])).map((x) => x.qr_code);
    const bad = await post(u().superAdmin.email, `/bo/clients/${t.data.entreprises.promoteur}/packs`, { nom: 'Bureau témoin', biens: [{ qr: 'A-INCONNU' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('ETIQUETTE_INCONNUE');
    const r = await post(u().superAdmin.email, `/bo/clients/${t.data.entreprises.promoteur}/packs`, {
      nom: 'Bureau témoin',
      projetId: t.data.projets.jardins,
      biens: [{ qr: qrs[0]!.toLowerCase(), piece: 'Bureau' }, { qr: qrs[1]!, piece: 'Accueil' }],
    });
    expect(r.status).toBe(201);
    pack = r.body.id;
    expect((await get(u().superAdmin.email, `/bo/clients/${t.data.entreprises.promoteur}/packs`)).body.items.map((p: { nom: string }) => p.nom)).toContain('Bureau témoin');
    // le client le retrouve parmi ses packs ; le personnel d'exploitation hors Super Admin n'y touche pas
    expect((await get(u().b2bAdmin.email, '/me/cart-templates')).body.items.map((p: { nom: string }) => p.nom)).toContain('Bureau témoin');
    expect((await get(u().operator.email, `/bo/clients/${t.data.entreprises.promoteur}/packs`)).status).toBe(403);
    expect((await pdf(u().superAdmin.email, `/bo/packs/${pack}/planche.pdf`)).status).toBe(200);
    const audit = await sys<{ action: string }>(`SELECT action FROM journal_audit WHERE objet_id = $1`, [pack], 'SUPER_ADMIN');
    expect(audit.map((a) => a.action)).toEqual(['PACK_CREE']);
    expect((await del(u().superAdmin.email, `/bo/packs/${pack}`)).status).toBe(200);
  });
});

describe('activités du client', () => {
  it('fil des entrées, demandes et documents, du plus récent au plus ancien, filtrable et paginé', async () => {
    const r = await get(u().b2bAdmin.email, '/me/activites?limite=5');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(5);
    const dates = r.body.items.map((x: { le: string }) => Date.parse(x.le));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(r.body.suivant).toBeTruthy();
    const next = await get(u().b2bAdmin.email, `/me/activites?limite=5&avant=${encodeURIComponent(r.body.suivant)}`);
    expect(next.status).toBe(200);
    expect(next.body.items).toHaveLength(5);
    expect(Date.parse(next.body.items[0].le)).toBeLessThanOrEqual(Date.parse(r.body.items[4].le));
    // aucune activité en double d'une page à l'autre
    const seen = new Set(r.body.items.map((x: { id: string }) => x.id));
    expect(next.body.items.some((x: { id: string }) => seen.has(x.id))).toBe(false);
    const stock = await get(u().b2bAdmin.email, '/me/activites?filtre=stock&limite=100');
    expect(stock.body.items.length).toBeGreaterThan(0);
    expect(stock.body.items.every((x: { genre: string }) => x.genre === 'MOUVEMENT')).toBe(true);
    expect(stock.body.items.find((x: { titre: string }) => x.titre === 'Arrivé au dépôt')).toMatchObject({ article: { qr: expect.any(String) } });
  });

  it('chacun ne voit que son périmètre', async () => {
    const mine = new Set(t.data.articles.tilleuls);
    const user = await get(u().b2bUser.email, '/me/activites?filtre=stock&limite=100');
    expect(user.status).toBe(200);
    expect(user.body.items.every((x: { article: { id: string } }) => mine.has(x.article.id))).toBe(true);
    const other = await get(u().otherB2bAdmin.email, '/me/activites?filtre=stock&limite=100');
    expect(other.body.items.some((x: { article: { id: string } }) => mine.has(x.article.id))).toBe(false);
    expect((await get(u().superAdmin.email, '/me/activites')).status).toBe(403);
  });
});

describe('suppression d’une photo au Back-Office', () => {
  it('retire la photo de la fiche, du stockage et de l’Espace Client ; une photo de preuve reste', async () => {
    const id = t.data.articles.tilleuls[5]!;
    const fiche = await get(u().superAdmin.email, `/bo/warehouse/articles/${id}`);
    expect(fiche.status).toBe(200);
    const photo = fiche.body.photos[0] as { id: string; supprimable: boolean; vignette: string };
    expect(photo).toMatchObject({ supprimable: true, vignette: expect.stringContaining(photo.id) });
    const key = (await sys<{ cle_originale: string }>('SELECT cle_originale FROM photo WHERE id = $1', [photo.id]))[0]!.cle_originale;
    expect(existsSync(path.resolve('.storage', key))).toBe(true);

    expect((await del(u().operator.email, `/bo/warehouse/articles/${id}/photos/${photo.id}`)).status).toBe(403);
    const r = await del(u().superAdmin.email, `/bo/warehouse/articles/${id}/photos/${photo.id}`);
    expect(r.status).toBe(200);
    expect(existsSync(path.resolve('.storage', key))).toBe(false);
    expect((await get(u().b2bAdmin.email, `/articles/${id}`)).body.photos.map((p: { id: string }) => p.id)).not.toContain(photo.id);
    expect((await sys<{ action: string }>(`SELECT action FROM journal_audit WHERE objet_id = $1 AND action = 'PHOTO_SUPPRIMEE'`, [id], 'SUPER_ADMIN')).length).toBe(1);
    expect((await del(u().superAdmin.email, `/bo/warehouse/articles/${id}/photos/${photo.id}`)).status).toBe(404);

    const proof = crypto.randomUUID();
    await sys(`INSERT INTO photo (id, tenant_id, article_id, cle_originale, contexte, televersee) VALUES ($1,$2,$3,'x/preuve.jpg','RESERVE',true)`, [proof, t.data.tenantId, id]);
    const kept = await del(u().superAdmin.email, `/bo/warehouse/articles/${id}/photos/${proof}`);
    expect(kept.status).toBe(409);
    expect(kept.body.error.code).toBe('PHOTO_PREUVE');
  });
});

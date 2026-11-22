import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { AmbiancesService } from '../src/orders/ambiances.controller.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ambiancePrompt, pieceEnglish } from '../src/orders/higgsfield.js';

/**
 * Visuels d'aménagement des pièces d'un pack : génération par Higgsfield (serveur factice qui reprend l'API
 * documentée : dépôt signé, file d'attente, suivi, image), image ajoutée à la main, plafond mensuel.
 */

type Mode = 'ok' | 'nsfw' | 'refus';
const fake = {
  mode: 'ok' as Mode,
  base: '',
  submits: [] as { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[],
  uploads: [] as { headers: http.IncomingHttpHeaders; bytes: number }[],
  polls: new Map<string, number>(),
  modes: new Map<string, Mode>(),
};
let png: Buffer;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.method === 'POST' && url === '/files/generate-upload-url') {
      const n = fake.uploads.length + 1;
      return json(200, { public_url: `${fake.base}/pub/${n}.jpg`, upload_url: `${fake.base}/up/${n}`, upload_headers: { 'x-amz-test': 'oui' } });
    }
    if (req.method === 'PUT' && url.startsWith('/up/')) {
      fake.uploads.push({ headers: req.headers, bytes: Buffer.concat(chunks).length });
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'POST' && url === '/test/interieur') {
      if (req.headers.authorization !== 'Key test-id:test-secret') return json(401, { detail: 'bad key' });
      if (fake.mode === 'refus') return json(422, { detail: 'image_urls: invalid' });
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      fake.submits.push({ headers: req.headers, body });
      const id = `req-${fake.submits.length}`;
      fake.modes.set(id, fake.mode);
      return json(200, { status: 'queued', request_id: id, status_url: `${fake.base}/requests/${id}/status`, cancel_url: `${fake.base}/requests/${id}/cancel` });
    }
    const st = url.match(/^\/requests\/([^/]+)\/status$/);
    if (req.method === 'GET' && st) {
      const id = st[1]!;
      const n = (fake.polls.get(id) ?? 0) + 1;
      fake.polls.set(id, n);
      if (n === 1) return json(200, { status: 'queued', request_id: id });
      if (n === 2) return json(200, { status: 'in_progress', request_id: id });
      if (fake.modes.get(id) === 'nsfw') return json(200, { status: 'nsfw', request_id: id });
      return json(200, { status: 'completed', request_id: id, images: [{ url: `${fake.base}/img/${id}.png` }] });
    }
    if (req.method === 'GET' && url.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    json(404, { detail: 'not found' });
  });
});

let t: TestContext;
let owner: pg.Client;
let ambiances: AmbiancesService;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, p: string) => t.http().get(`/api/v1${p}`).set('Authorization', await auth(email));
const post = async (email: string, p: string, body: unknown = {}) => t.http().post(`/api/v1${p}`).set('Authorization', await auth(email)).send(body as object);
const del = async (email: string, p: string) => t.http().delete(`/api/v1${p}`).set('Authorization', await auth(email));
const bin = (r: { on: (e: string, f: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c) => chunks.push(c!));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};
const u = () => t.data.users;
async function sys(sql: string, params: unknown[] = []) {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
  const r = await owner.query(sql, params);
  await owner.query('COMMIT');
  return r;
}
const piecesOf = (d: { body: { pieces: { piece: string | null; ambiance: Record<string, unknown> | null }[] } }) => new Map(d.body.pieces.map((p) => [p.piece, p.ambiance]));

beforeAll(async () => {
  png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#c9b79c' } }).png().toBuffer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await bootstrap({
    HIGGSFIELD_URL: fake.base,
    HIGGSFIELD_API_KEY_ID: 'test-id',
    HIGGSFIELD_API_KEY_SECRET: 'test-secret',
    HIGGSFIELD_MODEL: '/test/interieur',
    HIGGSFIELD_IMAGE_FIELD: 'image_urls',
    HIGGSFIELD_PARAMS: '{"resolution":"2K"}',
    HIGGSFIELD_POLL_MS: '5',
    HIGGSFIELD_MAX_PAR_CLIENT: '3',
  });
  ambiances = t.app.get(AmbiancesService);
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
  await new Promise((r) => server.close(r));
});

describe('prompt', () => {
  it('décrit la pièce en anglais avec chaque meuble et ses dimensions', () => {
    expect(pieceEnglish('Chambre 2')).toBe('bedroom');
    expect(pieceEnglish('Véranda')).toBe('room called "Véranda"');
    const p = ambiancePrompt({ piece: 'Salon', description: 'Style scandinave', biens: [{ libelle: 'Canapé 3 places', dimensions: '2,1 × 0,9 × 0,8 m' }], references: 1 });
    expect(p).toContain('furnished living room in a French apartment');
    expect(p).toContain('- Canapé 3 places (2.1 × 0.9 × 0.8 metres)');
    expect(p).toContain('reference images');
    expect(p).toContain('Style scandinave');
    const accueil = ambiancePrompt({
      piece: 'Accueil',
      description: null,
      biens: [
        { libelle: 'Chaise visiteur 5', dimensions: '0,5 × 0,5 × 0,9 m' },
        { libelle: 'Chaise visiteur 6', dimensions: '0,5 × 0,5 × 0,9 m' },
        { libelle: 'Totem PLV 3', dimensions: null },
      ],
      references: 0,
    });
    expect(accueil).toContain('reception area in a French real-estate sales office');
    expect(accueil).toContain('- 2 × Chaise visiteur (0.5 × 0.5 × 0.9 metres)\n- Totem PLV\n');
    expect(accueil).not.toContain('reference images');
  });
});

describe('visuels des pièces d’un pack', () => {
  let pack: string;

  it('génère le visuel d’une pièce avec Higgsfield, à partir des meubles et de leurs photos', async () => {
    const [a, b, c] = t.data.articles.tilleuls;
    const r = await post(u().b2bAdmin.email, '/me/cart-templates', {
      nom: 'T3 témoin visuels',
      description: 'Style scandinave clair',
      projetId: t.data.projets.tilleuls,
      articleIds: [a, b, c],
      pieces: { [a!]: 'salon', [b!]: 'salon', [c!]: 'chambre' },
    });
    expect(r.status).toBe(201);
    pack = r.body.id;
    const before = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    expect(before.body.visuels).toEqual({ ia: true, restantsCeMois: 3 });
    expect(piecesOf(before).get('Salon')).toBeNull();

    const g = await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'salon' });
    expect(g.status).toBe(202);
    expect(g.body).toMatchObject({ piece: 'Salon', statut: 'EN_COURS' });
    const during = await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Salon' });
    expect(during.status).toBe(409);
    await ambiances.idle();

    // requête conforme à l'API : clé, idempotence, prompt, photos déposées, paramètres libres
    const s = fake.submits[0]!;
    expect(s.headers['idempotency-key']).toBe(g.body.id);
    expect(s.body).toMatchObject({ aspect_ratio: '4:3', resolution: '2K' });
    expect(String(s.body.prompt)).toContain('living room');
    expect(String(s.body.prompt)).toContain('Style scandinave clair');
    expect(Array.isArray(s.body.image_urls)).toBe(true);
    expect((s.body.image_urls as string[]).length).toBe(fake.uploads.length);
    for (const up of fake.uploads) {
      expect(up.headers['x-amz-test']).toBe('oui');
      expect(up.headers.authorization).toBeUndefined();
      expect(up.bytes).toBeGreaterThan(100);
    }

    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    const amb = piecesOf(d).get('Salon')!;
    expect(amb).toMatchObject({ statut: 'PRET', source: 'IA', erreur: null });
    expect(amb.url).toMatch(/^\/api\/v1\/files\/ambiances\//);
    expect(piecesOf(d).get('Chambre')).toBeNull();
    expect(d.body.visuels.restantsCeMois).toBe(2);
    const img = await t.http().get(amb.url as string).buffer(true).parse(bin);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(img.body as Buffer).metadata()).width).toBe(1200);
    // lien falsifié
    expect((await t.http().get((amb.url as string).replace(/s=[^&]+/, 's=xxxxxxxxxxxxxxxx'))).status).toBe(403);
  });

  it('met le visuel en tête de la pièce dans la planche PDF', async () => {
    const withImg = await t.http().get(`/api/v1/me/cart-templates/${pack}/planche.pdf`).set('Authorization', await auth(u().b2bAdmin.email)).buffer(true).parse(bin);
    expect(withImg.status).toBe(200);
    const images = (b: Buffer) => (b.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
    await del(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances?piece=Salon`);
    const without = await t.http().get(`/api/v1/me/cart-templates/${pack}/planche.pdf`).set('Authorization', await auth(u().b2bAdmin.email)).buffer(true).parse(bin);
    expect(images(withImg.body as Buffer)).toBe(images(without.body as Buffer) + 1);
    // retiré, mais compté dans le plafond
    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    expect(piecesOf(d).get('Salon')).toBeNull();
    expect(d.body.visuels.restantsCeMois).toBe(2);
  });

  it('signale un refus du filtre de contenu sans le compter, et refuse une pièce vide', async () => {
    fake.mode = 'nsfw';
    expect((await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Chambre' })).status).toBe(202);
    await ambiances.idle();
    fake.mode = 'ok';
    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    expect(piecesOf(d).get('Chambre')).toMatchObject({ statut: 'ECHEC', url: null, erreur: expect.stringContaining('filtre de contenu') });
    expect(d.body.visuels.restantsCeMois).toBe(2);
    const vide = await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Cuisine' });
    expect(vide.status).toBe(422);
    expect(vide.body.error.code).toBe('PIECE_INCONNUE');
    // un B2B Utilisateur ne touche pas au pack d'un autre
    expect((await post(u().b2bUser.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Salon' })).status).toBe(403);
  });

  it('remplace le visuel par une image ajoutée à la main', async () => {
    const jpg = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#7a8f9c' } }).jpeg().toBuffer();
    const r = await t
      .http()
      .put(`/api/v1/me/cart-templates/${pack}/ambiances?piece=${encodeURIComponent('chambre')}`)
      .set('Authorization', await auth(u().b2bAdmin.email))
      .set('Content-Type', 'image/jpeg')
      .send(jpg);
    expect(r.status).toBe(200);
    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${pack}`);
    const amb = piecesOf(d).get('Chambre')!;
    expect(amb).toMatchObject({ statut: 'PRET', source: 'MANUEL' });
    const img = await t.http().get(amb.url as string).buffer(true).parse(bin);
    expect((await sharp(img.body as Buffer).metadata()).width).toBe(1600);
    const bad = await t
      .http()
      .put(`/api/v1/me/cart-templates/${pack}/ambiances?piece=Chambre`)
      .set('Authorization', await auth(u().b2bAdmin.email))
      .set('Content-Type', 'image/png')
      .send(Buffer.from('pas une image'));
    expect(bad.status).toBe(422);
  });

  it('applique le plafond mensuel, y compris au Back-Office, et garde le compte après suppression du pack', async () => {
    const boGen = await post(u().superAdmin.email, `/bo/packs/${pack}/ambiances/ia`, { piece: 'Salon' });
    expect(boGen.body).toMatchObject({ statut: 'EN_COURS' });
    await ambiances.idle();
    expect((await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Chambre' })).status).toBe(202);
    await ambiances.idle();
    const bo = await get(u().superAdmin.email, `/bo/packs/${pack}`);
    expect(bo.body.visuels.restantsCeMois).toBe(0);
    expect(piecesOf(bo).get('Chambre')).toMatchObject({ statut: 'PRET', source: 'IA' });
    const over = await post(u().b2bAdmin.email, `/me/cart-templates/${pack}/ambiances/ia`, { piece: 'Salon' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('PLAFOND_ATTEINT');

    expect((await del(u().b2bAdmin.email, `/me/cart-templates/${pack}`)).status).toBe(200);
    const rows = await sys(`SELECT pack_id, statut FROM pack_ambiance WHERE source = 'IA' AND erreur IS NULL`);
    expect(rows.rows.length).toBe(3);
    expect(rows.rows.every((x: { pack_id: string | null; statut: string }) => x.pack_id === null && x.statut === 'SUPPRIME')).toBe(true);
  });

  it('refuse proprement une requête rejetée par Higgsfield', async () => {
    await sys(`DELETE FROM pack_ambiance`);
    const [a] = t.data.articles.tilleuls;
    const r = await post(u().b2bAdmin.email, '/me/cart-templates', { nom: 'Refus', projetId: t.data.projets.tilleuls, articleIds: [a], pieces: { [a!]: 'Bureau' } });
    fake.mode = 'refus';
    expect((await post(u().b2bAdmin.email, `/me/cart-templates/${r.body.id}/ambiances/ia`, { piece: 'Bureau' })).status).toBe(202);
    await ambiances.idle();
    fake.mode = 'ok';
    const d = await get(u().b2bAdmin.email, `/me/cart-templates/${r.body.id}`);
    expect(piecesOf(d).get('Bureau')).toMatchObject({ statut: 'ECHEC', erreur: expect.stringContaining('Requête refusée par Higgsfield') });
  });

  it('sans clé Higgsfield, la génération est désactivée et l’image à la main reste possible', async () => {
    const config = loadConfig({ APP_DATABASE_URL: APP_URL, JWT_SECRET: 'test-secret-test-secret-test-secret-123', TENANT_ID: t.data.tenantId });
    const app = await createApp(config);
    await app.init();
    try {
      const { default: request } = await import('supertest');
      const token = await auth(u().b2bAdmin.email);
      const packs = await request(app.getHttpServer()).get('/api/v1/me/cart-templates').set('Authorization', token);
      const id = packs.body.items[0].id as string;
      const d = await request(app.getHttpServer()).get(`/api/v1/me/cart-templates/${id}`).set('Authorization', token);
      expect(d.body.visuels).toEqual({ ia: false, restantsCeMois: null });
      const g = await request(app.getHttpServer()).post(`/api/v1/me/cart-templates/${id}/ambiances/ia`).set('Authorization', token).send({ piece: 'Bureau' });
      expect(g.status).toBe(422);
      expect(g.body.error.code).toBe('IA_INACTIVE');
    } finally {
      await app.close();
    }
  });
});

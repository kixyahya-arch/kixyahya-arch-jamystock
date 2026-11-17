import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateQrCode } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Dépôts et emplacements (WMS-01, WMS-02), étiquettes (WMS-03), corrections de stock (WMS-06). */
let t: TestContext;
const as = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await as(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);
const put = async (email: string, path: string, body: unknown) => t.http().put(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);
const del = async (email: string, path: string) => t.http().delete(`/api/v1${path}`).set('Authorization', await as(email));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const binParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const postBin = async (email: string, path: string, body: unknown) =>
  t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object).buffer(true).parse(binParser);

let admin: string;
let owner: pg.Client;
let depotId: string;
let zoneId: string;

async function sys<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], role = 'SYSTEM') {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', $2, true)`, [t.data.tenantId, role]);
  try {
    const r = await owner.query<T>(sql, params);
    await owner.query('COMMIT');
    return r;
  } catch (e) {
    await owner.query('ROLLBACK');
    throw e;
  }
}

beforeAll(async () => {
  t = await bootstrap();
  admin = t.data.users.superAdmin.email;
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('dépôts et zones (WMS-01)', () => {
  it('réservé au Super Admin', async () => {
    expect((await get(t.data.users.dispatcher.email, '/bo/warehouse/depots')).status).toBe(403);
    expect((await get(t.data.users.operator.email, '/bo/warehouse/depots')).status).toBe(403);
  });

  it('crée un dépôt et une zone, refuse un code en double', async () => {
    const d = await post(admin, '/bo/warehouse/depots', { nom: 'Dépôt Sud', code: 's', adresse: '4 rue du Port, 94200 Ivry-sur-Seine', surfaceTotaleM2: 2400 });
    expect(d.status).toBe(201);
    depotId = d.body.id;
    expect((await post(admin, '/bo/warehouse/depots', { nom: 'Autre', code: 'S' })).status).toBe(409);
    const z = await post(admin, '/bo/warehouse/zones', { depotId, code: 'a', nom: 'Zone A' });
    expect(z.status).toBe(201);
    zoneId = z.body.id;
    expect((await post(admin, '/bo/warehouse/zones', { depotId, code: 'A', nom: 'Doublon' })).status).toBe(409);
    const list = await get(admin, '/bo/warehouse/depots');
    expect(list.body.items.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['N', 'S']));
    expect(list.body.formats.avery.length).toBeGreaterThan(2);
  });
});

describe('génération en masse (WMS-02)', () => {
  it('aperçu sans écriture, puis création avec nœud d’allée et chemins lisibles', async () => {
    const body = { zoneId, allees: '4', niveaux: '1-5', cases: '1-20', type: 'RACK', longueurM: 1.2, largeurM: 0.8, hauteurM: 1.5, chargeMaxKg: 800 };
    const preview = await post(admin, '/bo/warehouse/emplacements/generate', body);
    expect(preview.status).toBe(201);
    expect(preview.body).toMatchObject({ total: 100, nouveaux: 100, cree: 0, surfaceTotaleM2: 96 });
    expect(preview.body.apercu[0]).toEqual({ code: 'S-A-04-101', chemin: 'Dépôt Sud > Zone A > Allée 4 > Niveau 1 > Case 1', existe: false });
    expect((await get(admin, `/bo/warehouse/depots/${depotId}`)).body.emplacements).toHaveLength(0);

    const done = await post(admin, '/bo/warehouse/emplacements/generate', { ...body, dryRun: false });
    expect(done.body.cree).toBe(100);
    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    expect(tree.emplacements).toHaveLength(101);
    const allee = tree.emplacements.find((e: { code: string }) => e.code === 'S-A-04');
    expect(allee).toMatchObject({ adressable: false, chemin: 'Dépôt Sud > Zone A > Allée 4', niveaux: 5 });
    const e = tree.emplacements.find((x: { code: string }) => x.code === 'S-A-04-520');
    expect(e).toMatchObject({ parentId: allee.id, type: 'RACK', surfaceM2: 0.96, chargeMaxKg: 800, statut: 'ACTIF', chemin: 'Dépôt Sud > Zone A > Allée 4 > Niveau 5 > Case 20' });
    expect(e.qrCode).toMatch(/^E/);

    // relancer la même génération ne crée rien de plus ; l'élargir ne crée que les nouveaux
    expect((await post(admin, '/bo/warehouse/emplacements/generate', { ...body, dryRun: false })).status).toBe(409);
    const more = await post(admin, '/bo/warehouse/emplacements/generate', { ...body, cases: '1-22', dryRun: false });
    expect(more.body).toMatchObject({ total: 110, existants: 100, cree: 10 });
  });

  it('motif invalide : message lisible', async () => {
    const r = await post(admin, '/bo/warehouse/emplacements/generate', { zoneId, allees: '1-40', niveaux: '1-10', cases: '1-20' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('au plus 2000');
  });

  it('import CSV : aperçu des erreurs, refus tant qu’il en reste, puis création', async () => {
    const bad = ['zone;code;type;longueur_m;largeur_m;surface_m2;statut', 'A;S-A-SOL1;sol;4;3;;actif', 'Z;S-Z-1;sol;;;;', 'A;S-A-04-101;rack;;;;'].join('\n');
    const p = await post(admin, `/bo/warehouse/depots/${depotId}/import`, { csv: bad });
    expect(p.body).toMatchObject({ valides: 1, nbErreurs: 2 });
    expect(p.body.erreurs.map((e: { message: string }) => e.message)).toEqual(['zone « Z » inconnue dans ce dépôt', 'l’emplacement S-A-04-101 existe déjà']);
    expect((await post(admin, `/bo/warehouse/depots/${depotId}/import`, { csv: bad, dryRun: false })).status).toBe(422);
    const ok = await post(admin, `/bo/warehouse/depots/${depotId}/import`, { csv: bad.split('\n').slice(0, 2).join('\n'), dryRun: false });
    expect(ok.body.cree).toBe(1);
    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    expect(tree.emplacements.find((e: { code: string }) => e.code === 'S-A-SOL1')).toMatchObject({ surfaceM2: 12, type: 'SOL' });
  });

  it('renommer la zone met à jour les chemins ; une zone non vide ne se supprime pas', async () => {
    expect((await put(admin, `/bo/warehouse/zones/${zoneId}`, { nom: 'Zone A — racks' })).status).toBe(200);
    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    expect(tree.emplacements.find((e: { code: string }) => e.code === 'S-A-04-101').chemin).toBe('Dépôt Sud > Zone A — racks > Allée 4 > Niveau 1 > Case 1');
    expect((await del(admin, `/bo/warehouse/zones/${zoneId}`)).status).toBe(409);
  });

  it('bloquer un emplacement ; suppression refusée s’il a servi, acceptée sinon', async () => {
    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    const e = tree.emplacements.find((x: { code: string }) => x.code === 'S-A-04-102');
    const r = await put(admin, `/bo/warehouse/emplacements/${e.id}`, { statut: 'MAINTENANCE', motif: 'Lisse endommagée' });
    expect(r.status).toBe(200);
    expect((await del(admin, `/bo/warehouse/emplacements/${e.id}`)).status).toBe(200);
    const allee = tree.emplacements.find((x: { code: string }) => x.code === 'S-A-04');
    expect((await del(admin, `/bo/warehouse/emplacements/${allee.id}`)).status).toBe(409);
  });
});

describe('étiquettes (WMS-03)', () => {
  it('planche Avery en PDF, rouleau Zebra en ZPL', async () => {
    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    const ids = tree.emplacements.filter((e: { adressable: boolean }) => e.adressable).slice(0, 25).map((e: { id: string }) => e.id);
    const pdf = await postBin(admin, '/bo/warehouse/labels', { kind: 'EMPLACEMENT', ids, format: 'L7160', skip: 3 });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((body.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(2); // 3 sautées + 25 = 28 > 21

    const zpl = await post(admin, '/bo/warehouse/labels', { kind: 'EMPLACEMENT', ids: ids.slice(0, 2), format: 'ZEBRA_50x25', sortie: 'ZPL' });
    expect(zpl.headers['content-type']).toContain('text/plain');
    expect((zpl.text.match(/\^XA/g) ?? []).length).toBe(2);
    expect(zpl.text).toMatch(/Depot Sud - E[A-Z0-9]{10}|Depot Sud . E/);

    const art = await postBin(admin, '/bo/warehouse/labels', { kind: 'ARTICLE', ids: t.data.articles.tilleuls.slice(0, 2), format: 'ZEBRA_100x50' });
    expect(art.status).toBe(200);
    expect((await post(admin, '/bo/warehouse/labels', { kind: 'EMPLACEMENT', ids, format: 'L7160', sortie: 'ZPL' })).status).toBe(422);

    // planche de QR vierges pour la réception
    const blank = await post(admin, '/labels/blank', { type: 'A', count: 21, lot: 'LOT-TEST-1' });
    expect(blank.body.codes).toHaveLength(21);
    const sheet = await postBin(admin, '/bo/warehouse/labels', { kind: 'VIERGE', lot: 'LOT-TEST-1', format: 'L7160' });
    expect(sheet.status).toBe(200);
    expect(((sheet.body as Buffer).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
  });
});

describe('corrections de stock (WMS-06)', () => {
  const article = () => t.data.articles.tilleuls[1]!;
  const lastMove = async (id: string) =>
    (await sys<{ type: string; motif: string; statut_apres: string; auteur_id: string }>('SELECT type, motif, statut_apres, auteur_id FROM mouvement WHERE article_id = $1 ORDER BY horodatage_serveur DESC, id DESC LIMIT 1', [id])).rows[0]!;

  it('motif obligatoire', async () => {
    const r = await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'PERDU', motif: '' });
    expect(r.status).toBe(400);
  });

  it('déplacer : mouvement AJUSTEMENT avec motif, entrée d’audit, emplacement indisponible refusé', async () => {
    const r = await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'DEPLACER', emplacement: 's-a-sol1', motif: 'Rangé au mauvais endroit' });
    expect(r.status).toBe(201);
    const fiche = (await get(admin, `/bo/warehouse/articles/${article()}`)).body;
    expect(fiche.emplacementCode).toBe('S-A-SOL1');
    expect(fiche.mouvements[0]).toMatchObject({ type: 'AJUSTEMENT', motif: 'Déplacement : Rangé au mauvais endroit', auteur: 'Responsable exploitation' });
    const audit = await sys<{ action: string; motif: string }>(`SELECT action, motif FROM journal_audit WHERE objet_id = $1 ORDER BY horodatage DESC LIMIT 1`, [article()], 'SUPER_ADMIN');
    expect(audit.rows[0]).toEqual({ action: 'STOCK_DEPLACER', motif: 'Rangé au mauvais endroit' });

    const tree = (await get(admin, `/bo/warehouse/depots/${depotId}`)).body;
    const blocked = tree.emplacements.find((x: { code: string }) => x.code === 'S-A-04-103');
    await put(admin, `/bo/warehouse/emplacements/${blocked.id}`, { statut: 'BLOQUE' });
    const refused = await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'DEPLACER', emplacement: blocked.qrCode, motif: 'Essai' });
    expect(refused.status).toBe(422);
    // bloquer un emplacement occupé exige un motif
    const sol = tree.emplacements.find((x: { code: string }) => x.code === 'S-A-SOL1');
    expect((await put(admin, `/bo/warehouse/emplacements/${sol.id}`, { statut: 'BLOQUE' })).status).toBe(422);
  });

  it('perdu puis retrouvé ; endommagé', async () => {
    expect((await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'PERDU', motif: 'Introuvable à l’inventaire' })).body).toMatchObject({ statut: 'PERDU', emplacementId: null });
    expect(await lastMove(article())).toMatchObject({ type: 'AJUSTEMENT', statut_apres: 'PERDU' });
    expect((await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'PERDU', motif: 'Encore' })).status).toBe(409);
    const found = await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'RETROUVE', emplacement: 'S-A-04-104', motif: 'Retrouvé derrière une palette' });
    expect(found.body).toMatchObject({ statut: 'EN_STOCK' });
    const dmg = await post(admin, `/bo/warehouse/articles/${article()}/correction`, { action: 'ENDOMMAGE', motif: 'Pied cassé à la manutention' });
    expect(dmg.body).toMatchObject({ etat: 'ENDOMMAGE', statut: 'EN_STOCK' });
    // la cliente voit l'état à jour dans son inventaire
    const seen = await get(t.data.users.b2bAdmin.email, `/articles/${article()}`);
    expect(seen.body.etat).toBe('ENDOMMAGE');
  });

  it('scinder et fusionner des unités de manutention', async () => {
    const [a1, a2, a3] = t.data.articles.tilleuls.slice(5, 8) as [string, string, string];
    const loc = (await sys<{ id: string }>(`SELECT id FROM emplacement WHERE code = 'S-A-04-105'`)).rows[0]!.id;
    const loc2 = (await sys<{ id: string }>(`SELECT id FROM emplacement WHERE code = 'S-A-04-106'`)).rows[0]!.id;
    const u1 = generateQrCode('U');
    const u2 = generateQrCode('U');
    const ids = (
      await sys<{ id: string }>(
        `INSERT INTO unite_manutention (tenant_id, entreprise_id, type, qr_code, emplacement_courant_id) VALUES ($1,$2,'PALETTE',$3,$4), ($1,$2,'PALETTE',$5,$6) RETURNING id`,
        [t.data.tenantId, t.data.entreprises.promoteur, u1, loc, u2, loc2],
      )
    ).rows.map((r) => r.id);
    await sys(`UPDATE article SET um_courante_id = $2, emplacement_courant_id = $3 WHERE id = ANY($1)`, [[a1, a2], ids[0], loc]);
    await sys(`UPDATE article SET um_courante_id = $2, emplacement_courant_id = $3 WHERE id = $1`, [a3, ids[1], loc2]);

    const split = await post(admin, `/bo/warehouse/articles/${a1}/correction`, { action: 'RETIRER_UM', motif: 'Chaise sortie de la palette' });
    expect(split.body).toMatchObject({ umId: null, emplacementId: loc });

    const merge = await post(admin, `/bo/warehouse/articles/${a3}/correction`, { action: 'FUSIONNER_UM', umCible: `https://q.jamystock.fr/U/${u1.slice(1)}`, motif: 'Regroupement des palettes Tilleuls' });
    expect(merge.body).toMatchObject({ umQr: u1, articles: 1 });
    const after = (await sys<{ um_courante_id: string; emplacement_courant_id: string }>('SELECT um_courante_id, emplacement_courant_id FROM article WHERE id = $1', [a3])).rows[0]!;
    expect(after).toEqual({ um_courante_id: ids[0], emplacement_courant_id: loc });
    const old = (await sys<{ actif: boolean }>('SELECT actif FROM unite_manutention WHERE id = $1', [ids[1]])).rows[0]!;
    expect(old.actif).toBe(false);
  });
});

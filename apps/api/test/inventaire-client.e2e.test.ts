import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type SyncResult } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Lot 2 : export de l'inventaire (INV-05), annotations client (INV-06), demande de photo ou de constat (INV-07), estimation de facture (ADM-02). */
let t: TestContext;
let owner: pg.Client;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await auth(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const put = async (email: string, path: string, body: unknown) => t.http().put(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const binary = async (email: string, path: string) =>
  t
    .http()
    .get(`/api/v1${path}`)
    .set('Authorization', await auth(email))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

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

const u = () => t.data.users;

beforeAll(async () => {
  t = await bootstrap({ PUBLIC_URL: 'https://app.jamystock.test' });
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('annotations du client (INV-06)', () => {
  it('le client renomme, référence, catégorise et annote son bien ; le libellé du dépôt ne change pas', async () => {
    const id = t.data.articles.tilleuls[1]!;
    const r = await put(u().b2bAdmin.email, `/articles/${id}/annotation`, {
      nomClient: 'Bureau accueil RDC',
      referenceInterne: 'IMMO-0042',
      categorieClient: 'Mobilier accueil',
      noteClient: 'À reprendre pour le salon de mars',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nomClient: 'Bureau accueil RDC', referenceInterne: 'IMMO-0042', categorieClient: 'Mobilier accueil' });
    const a = await sys<{ libelle: string; annote_par: string }>('SELECT libelle, annote_par FROM article WHERE id = $1', [id]);
    expect(a.rows[0]).toMatchObject({ libelle: "Bureau d'accueil 1", annote_par: u().b2bAdmin.id });

    // champ omis : inchangé ; chaîne vide : effacé
    const r2 = await put(u().b2bUser.email, `/articles/${id}/annotation`, { noteClient: '' });
    expect(r2.body).toMatchObject({ nomClient: 'Bureau accueil RDC', noteClient: null });

    const audit = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM journal_audit WHERE action = 'ARTICLE_ANNOTE' AND objet_id = $1`, [id], 'SUPER_ADMIN');
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('la recherche et le filtre trouvent les biens par référence interne et catégorie client', async () => {
    const id = t.data.articles.tilleuls[1]!;
    const s = await get(u().b2bAdmin.email, '/articles?q=IMMO-0042');
    expect(s.body.items.map((x: { id: string }) => x.id)).toContain(id);
    const f = await get(u().b2bAdmin.email, `/articles?categorieClient=${encodeURIComponent('mobilier ACCUEIL')}`);
    expect(f.body.items.map((x: { id: string }) => x.id)).toEqual([id]);
    expect(f.body.items[0]).toMatchObject({ referenceInterne: 'IMMO-0042', categorieClient: 'Mobilier accueil' });
    const cats = await get(u().b2bAdmin.email, '/me/inventory/categories');
    expect(cats.body.items).toEqual([{ nom: 'Mobilier accueil', n: 1 }]);
  });

  it('refuse le personnel et les biens d’un autre client', async () => {
    const id = t.data.articles.tilleuls[1]!;
    expect((await put(u().dispatcher.email, `/articles/${id}/annotation`, { nomClient: 'x' })).status).toBe(403);
    expect((await put(u().otherB2bAdmin.email, `/articles/${id}/annotation`, { nomClient: 'x' })).status).toBe(404);
    // un utilisateur B2B ne voit que ses projets
    expect((await put(u().b2bUser.email, `/articles/${t.data.articles.jardins[0]!}/annotation`, { nomClient: 'x' })).status).toBe(404);
  });
});

describe('export de l’inventaire (INV-05)', () => {
  it('CSV filtré comme la vue courante, lisible par Excel', async () => {
    const r = await binary(u().b2bAdmin.email, `/me/inventory/export.csv?projet=${t.data.projets.tilleuls}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    const text = (r.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toContain('Référence interne');
    expect(lines).toHaveLength(1 + t.data.articles.tilleuls.length);
    expect(text).toContain('IMMO-0042');
    expect(text).not.toContain('Bureau direction');

    const filtered = await binary(u().b2bAdmin.email, '/me/inventory/export.csv?categorieClient=Mobilier%20accueil');
    expect((filtered.body as Buffer).toString('utf8').trim().split('\r\n')).toHaveLength(2);
    expect((await get(u().dispatcher.email, '/me/inventory/export.csv')).status).toBe(403);
  });

  it('PDF illustré préparé en tâche de fond, notifié quand il est prêt', async () => {
    const start = await post(u().b2bAdmin.email, '/me/inventory/exports', { projet: t.data.projets.tilleuls });
    expect(start.status).toBe(202);
    const id = start.body.id as string;
    let statut = 'EN_COURS';
    for (let i = 0; i < 50 && statut === 'EN_COURS'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const l = await get(u().b2bAdmin.email, '/me/inventory/exports');
      statut = l.body.items.find((x: { id: string }) => x.id === id)?.statut;
    }
    expect(statut).toBe('PRET');
    const file = await binary(u().b2bAdmin.email, `/me/inventory/exports/${id}/file`);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const n = await sys<{ canal: string }>(`SELECT canal FROM notification WHERE modele = 'EXPORT_PRET' AND variables->>'exportId' = $1 ORDER BY canal`, [id]);
    expect(n.rows.map((x) => x.canal)).toEqual(['EMAIL', 'IN_APP']);
    // l'export est personnel
    expect((await binary(u().b2bUser.email, `/me/inventory/exports/${id}/file`)).status).toBe(404);
  });
});

describe('estimation de la prochaine facture (ADM-02)', () => {
  it('le titulaire du compte voit l’estimation du mois en cours ; un simple utilisateur non', async () => {
    const r = await get(u().b2bAdmin.email, '/me/billing/estimate');
    expect(r.status).toBe(200);
    expect(r.body.mois).toMatch(/^\d{4}-\d{2}$/);
    expect(r.body.factures.length).toBeGreaterThan(0);
    expect(r.body.totalTtcCents).toBe(r.body.totalHtCents + r.body.tvaCents);
    const f = r.body.factures[0];
    expect(f.joursReleves + f.joursProjetes).toBeGreaterThan(27);
    expect((await get(u().b2bUser.email, '/me/billing/estimate')).status).toBe(403);
  });
});

describe('photo ou constat à la demande (INV-07)', () => {
  const article = () => t.data.articles.tilleuls[2]!;
  let missionId: string;

  it('crée une micro-mission « Photo » pour le dépôt, une seule à la fois par bien', async () => {
    const r = await post(u().b2bUser.email, `/articles/${article()}/requests`, { type: 'CONSTAT', message: 'Le plateau est-il rayé ?' });
    expect(r.status).toBe(201);
    missionId = r.body.id;
    const m = await sys<{ type: string; statut: string; donnees: Record<string, unknown> }>('SELECT type, statut, donnees FROM mission WHERE id = $1', [missionId]);
    expect(m.rows[0]).toMatchObject({ type: 'PHOTO', statut: 'A_AFFECTER', donnees: { articleId: article(), demande: 'CONSTAT', demandeurId: u().b2bUser.id } });
    const staff = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE modele = 'DEMANDE_PHOTO' AND variables->>'missionId' = $1`, [missionId]);
    expect(staff.rows[0]!.n).toBeGreaterThanOrEqual(2);

    expect((await post(u().b2bAdmin.email, `/articles/${article()}/requests`, { type: 'PHOTO', message: 'Une autre vue' })).status).toBe(409);
    expect((await post(u().dispatcher.email, `/articles/${article()}/requests`, { type: 'PHOTO', message: 'Une autre vue' })).status).toBe(403);
    expect((await post(u().otherB2bAdmin.email, `/articles/${article()}/requests`, { type: 'PHOTO', message: 'Une autre vue' })).status).toBe(404);
    const list = await get(u().b2bUser.email, `/articles/${article()}/requests`);
    expect(list.body.items[0]).toMatchObject({ id: missionId, statut: 'A_AFFECTER', demande: 'CONSTAT' });
  });

  it('l’opérateur photographie le bien et constate son état ; le client est prévenu et la prestation pointée', async () => {
    await sys(`UPDATE mission SET statut = 'AFFECTEE', assigne_a = $2 WHERE id = $1`, [missionId, u().operator.id]);
    const detail = await get(u().operator.email, `/field/missions/${missionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.demande).toMatchObject({ type: 'CONSTAT', message: 'Le plateau est-il rayé ?', article: { id: article() } });

    const qr = (await sys<{ qr_code: string }>('SELECT qr_code FROM article WHERE id = $1', [article()])).rows[0]!.qr_code;
    const wrongQr = (await sys<{ qr_code: string }>('SELECT qr_code FROM article WHERE id = $1', [t.data.articles.tilleuls[3]!])).rows[0]!.qr_code;
    const sync = async (payload: Record<string, unknown>) => {
      const res = await post(u().operator.email, '/field/sync', {
        deviceId: 'terminal-test',
        deviceTime: new Date().toISOString(),
        actions: [{ key: uuidv7(), at: new Date().toISOString(), action: { type: 'PHOTO_REQUEST_DONE', payload } }],
      });
      expect(res.status).toBe(200);
      return res.body.results[0] as SyncResult;
    };
    expect(await sync({ missionId, articleQr: wrongQr, photoIds: [uuidv7()] })).toMatchObject({ status: 'ERROR', code: 'MAUVAIS_ARTICLE' });

    const photo = uuidv7();
    const done = await sync({ missionId, articleQr: qr, photoIds: [photo], etat: 'USE', commentaire: 'Rayure de 5 cm sur le plateau' });
    expect(done.status).toBe('OK');

    const m = await sys<{ statut: string }>('SELECT statut FROM mission WHERE id = $1', [missionId]);
    expect(m.rows[0]!.statut).toBe('TERMINEE');
    const a = await sys<{ etat: string }>('SELECT etat FROM article WHERE id = $1', [article()]);
    expect(a.rows[0]!.etat).toBe('USE');
    const ph = await sys<{ contexte: string }>('SELECT contexte FROM photo WHERE id = $1', [photo]);
    expect(ph.rows[0]!.contexte).toBe('CONSTAT');
    const p = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM prestation_a_facturer WHERE code = 'PHOTO_DEMANDE' AND source_id = $1`, [missionId]);
    expect(p.rows[0]!.n).toBe(1);
    const n = await sys<{ canal: string }>(
      `SELECT canal FROM notification WHERE modele = 'PHOTO_PRETE' AND destinataire_id = $1 AND variables->>'articleId' = $2 ORDER BY canal`,
      [u().b2bUser.id, article()],
    );
    expect(n.rows.map((x) => x.canal)).toEqual(['EMAIL', 'IN_APP']);

    const list = await get(u().b2bUser.email, `/articles/${article()}/requests`);
    expect(list.body.items[0]).toMatchObject({ statut: 'TERMINEE', commentaire: 'Rayure de 5 cm sur le plateau' });
    // une nouvelle demande redevient possible
    expect((await post(u().b2bUser.email, `/articles/${article()}/requests`, { type: 'PHOTO', message: 'Vue de dessous' })).status).toBe(201);
  });
});

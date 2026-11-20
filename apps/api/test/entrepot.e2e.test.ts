import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateQrCode, uuidv7, type FieldAction, type SyncResult } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Lot 4 : plan du dépôt (WMS-04), inventaire tournant (WMS-05), duplication (REC-05), suggestion d'emplacement (REC-06). */
let t: TestContext;
let owner: pg.Client;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await auth(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const putImage = async (email: string, path: string, data: Buffer) =>
  t.http().put(`/api/v1${path}`).set('Authorization', await auth(email)).set('Content-Type', 'image/jpeg').send(data);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

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
async function field(email: string, action: FieldAction): Promise<SyncResult> {
  const res = await post(email, '/field/sync', { deviceId: 'terminal-test', deviceTime: new Date().toISOString(), actions: [{ key: uuidv7(), at: new Date().toISOString(), action }] });
  expect(res.status).toBe(200);
  return res.body.results[0] as SyncResult;
}
const ok = (r: SyncResult) => {
  if (r.status !== 'OK') throw new Error(`${r.code} : ${r.message}`);
  return r.data as Record<string, unknown>;
};
const u = () => t.data.users;
const qrOf = async (id: string) => (await sys<{ qr_code: string }>('SELECT qr_code FROM article WHERE id = $1', [id])).rows[0]!.qr_code;
const locOf = async (id: string) => (await sys<{ emplacement_courant_id: string; statut: string }>('SELECT emplacement_courant_id, statut FROM article WHERE id = $1', [id])).rows[0]!;
const loc = async (code: string) => (await sys<{ id: string; qr_code: string }>('SELECT id, qr_code FROM emplacement WHERE code = $1', [code])).rows[0]!;

beforeAll(async () => {
  t = await bootstrap();
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('plan du dépôt (WMS-04)', () => {
  it('occupation par zone et par emplacement, réservée au Super Admin', async () => {
    const r = await get(u().superAdmin.email, `/bo/warehouse/depots/${t.data.depotId}/plan`);
    expect(r.status).toBe(200);
    const b = r.body.zones.find((z: { code: string }) => z.code === 'B');
    expect(b).toMatchObject({ nbEmplacements: 26, nbClients: 3 });
    expect(b.taux).toBeGreaterThan(0);
    const e = (code: string) => b.emplacements.find((x: { code: string }) => x.code === code);
    // le module préfabriqué (15 m²) déborde du sol de 12 m² : plein ; une case de rack vide : libre
    expect(e('N-B-S01')).toMatchObject({ etat: 'PLEIN', nbArticles: 2 });
    expect(e('N-B-04-101')).toMatchObject({ etat: 'PARTIEL', occupeM2: 0.13 });
    expect(e('N-B-04-504')).toMatchObject({ etat: 'LIBRE', nbArticles: 0 });
    expect(b.libres + b.partiels + b.pleins + b.indisponibles).toBe(26);
    expect((await get(u().dispatcher.email, `/bo/warehouse/depots/${t.data.depotId}/plan`)).status).toBe(403);

    const c = await get(u().superAdmin.email, `/bo/warehouse/zones/${b.id}/contents`);
    expect(c.body.clients[0]).toMatchObject({ client: 'Promotion Horizon SAS', projets: ['Bureau témoin Les Jardins', 'Stand de vente Résidence Les Tilleuls'] });
    expect(c.body.articles.length).toBe(c.body.clients.reduce((s: number, x: { nbArticles: number }) => s + x.nbArticles, 0));
    const one = await get(u().superAdmin.email, `/bo/warehouse/zones/${b.id}/contents?emplacement=${e('N-B-04-101').id}`);
    expect(one.body.articles).toEqual([expect.objectContaining({ libelle: 'Chaise visiteur 1', client: 'Promotion Horizon SAS' })]);
  });
});

describe('suggestion d’emplacement (REC-06)', () => {
  it('regroupe par projet et ne propose que des emplacements où l’objet tient', async () => {
    const op = u().operator.email;
    const chaise = await get(op, `/field/locations/suggest?entrepriseId=${t.data.entreprises.promoteur}&projetId=${t.data.projets.tilleuls}&longueurM=0.5&largeurM=0.5&empilable=true`);
    expect(chaise.status).toBe(200);
    expect(chaise.body.besoinM2).toBe(0.13);
    expect(chaise.body.suggestions).toHaveLength(3);
    expect(chaise.body.suggestions[0]).toMatchObject({ raison: 'Le même projet est déjà rangé ici' });
    expect(chaise.body.suggestions[0].code).toMatch(/^N-B-04-/);

    // un bureau (1,28 m²) ne tient pas dans une case de rack de 1,2 m²
    const bureau = await get(op, `/field/locations/suggest?entrepriseId=${t.data.entreprises.promoteur}&projetId=${t.data.projets.tilleuls}&longueurM=1.6&largeurM=0.8`);
    expect(bureau.body.suggestions.every((s: { code: string }) => s.code.startsWith('N-B-S'))).toBe(true);
    expect(bureau.body.suggestions[0]).toMatchObject({ raison: 'Le même projet est déjà rangé ici' });
    expect(bureau.body.suggestions.every((s: { code: string }) => s.code !== 'N-B-S01')).toBe(true);

    // un emplacement réservé à un autre client n'est jamais proposé
    const reserved = bureau.body.suggestions[0].id;
    await sys('UPDATE emplacement SET dedie_entreprise_id = $2 WHERE id = $1', [reserved, t.data.entreprises.autre]);
    const again = await get(op, `/field/locations/suggest?entrepriseId=${t.data.entreprises.promoteur}&projetId=${t.data.projets.tilleuls}&longueurM=1.6&largeurM=0.8`);
    expect(again.body.suggestions.map((s: { id: string }) => s.id)).not.toContain(reserved);
    await sys('UPDATE emplacement SET dedie_entreprise_id = NULL WHERE id = $1', [reserved]);
    expect((await get(u().driver.email, '/field/locations/suggest?longueurM=1&largeurM=1')).status).toBe(403);
  });
});

describe('duplication à la réception (REC-05)', () => {
  let source: string;
  const photo = uuidv7();

  it('crée N copies avec chacune son QR, la photo du modèle et une planche d’étiquettes', async () => {
    const op = u().operator.email;
    source = uuidv7();
    const blank = (await post(op, '/labels/blank', { count: 1 })).body.codes[0].code as string;
    ok(
      await field(op, {
        type: 'ARTICLE_CREATE',
        payload: {
          articleId: source, qr: blank, entrepriseId: t.data.entreprises.promoteur, projetId: t.data.projets.tilleuls,
          libelle: 'Chaise pliante noire', etat: 'BON', description: 'Lot du salon', longueurM: 0.45, largeurM: 0.45, hauteurM: 0.8, photos: [{ photoId: photo }],
        },
      }),
    );
    expect((await post(op, `/field/articles/${source}/duplicate`, { nombre: 51 })).status).toBe(400);
    const r = await post(op, `/field/articles/${source}/duplicate`, { nombre: 3 });
    expect(r.status).toBe(201);
    expect(r.body.articles).toHaveLength(3);
    const ids = r.body.articles.map((a: { id: string }) => a.id);
    expect(new Set(r.body.articles.map((a: { qrCode: string }) => a.qrCode)).size).toBe(3);
    const rows = await sys<{ libelle: string; description: string; longueur_m: string; statut: string; projet_id: string }>(
      'SELECT libelle, description, longueur_m, statut, projet_id FROM article WHERE id = ANY($1)',
      [ids],
    );
    expect(rows.rows.every((a) => a.libelle === 'Chaise pliante noire' && a.description === 'Lot du salon' && Number(a.longueur_m) === 0.45 && a.statut === 'EN_RECEPTION' && a.projet_id === t.data.projets.tilleuls)).toBe(true);

    // la photo du modèle arrive après (terminal hors réseau) : les copies deviennent visibles en même temps
    const copies = () => sys<{ televersee: boolean }>('SELECT televersee FROM photo WHERE copie_de = $1', [photo]);
    expect((await copies()).rows.map((x) => x.televersee)).toEqual([false, false, false]);
    expect((await putImage(op, `/field/photos/${photo}`, JPEG)).status).toBe(200);
    expect((await copies()).rows.map((x) => x.televersee)).toEqual([true, true, true]);

    const labels = await post(op, '/bo/warehouse/labels/articles', { ids, format: 'L7651' });
    expect(labels.status).toBe(200);
    expect(labels.headers['content-type']).toContain('application/pdf');
    expect((await post(u().dispatcher.email, '/bo/warehouse/labels/articles', { ids, format: 'L7651' })).status).toBe(403);

    // chaque copie se range comme un article normal
    const dest = await loc('N-B-04-504');
    ok(await field(op, { type: 'ARTICLE_STORE', payload: { articleQr: r.body.articles[0].qrCode, locationQr: dest.qr_code } }));
    expect(await locOf(ids[0])).toMatchObject({ emplacement_courant_id: dest.id, statut: 'EN_STOCK' });
    const audit = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM journal_audit WHERE action = 'ARTICLE_DUPLIQUE' AND objet_id = $1`, [source], 'SUPER_ADMIN');
    expect(audit.rows[0]!.n).toBe(1);
  });
});

describe('inventaire tournant (WMS-05)', () => {
  let invId: string;
  let missions: string[];
  let zoneB: string;
  const chaises = () => t.data.articles.tilleuls.slice(5, 11);

  it('le Super Admin lance le comptage d’une zone : missions de comptage affectées', async () => {
    zoneB = (await sys<{ id: string }>(`SELECT id FROM zone WHERE code = 'B'`)).rows[0]!.id;
    const r = await post(u().superAdmin.email, '/bo/inventaires', { zoneId: zoneB, parMission: 10, assigneA: u().operator.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ nbEmplacements: 26 });
    expect(r.body.numero).toMatch(/^INV-\d{4}-\d{6}$/);
    invId = r.body.id;
    missions = r.body.missions;
    expect(missions).toHaveLength(3);
    expect((await post(u().superAdmin.email, '/bo/inventaires', { zoneId: zoneB })).status).toBe(409);
    expect((await post(u().dispatcher.email, '/bo/inventaires', { zoneId: zoneB })).status).toBe(403);
    const plan = await get(u().superAdmin.email, `/bo/warehouse/depots/${t.data.depotId}/plan`);
    expect(plan.body.zones.find((z: { code: string }) => z.code === 'B').inventaire).toMatchObject({ id: invId, statut: 'EN_COURS' });
  });

  it('l’opérateur compte en aveugle ; manquants, articles déplacés et étiquettes inconnues sont relevés', async () => {
    const op = u().operator.email;
    const boot = await get(op, '/field/bootstrap');
    expect(boot.body.missions.filter((m: { type: string }) => m.type === 'INVENTAIRE')).toHaveLength(3);
    const detail = await get(op, `/field/missions/${missions[0]}`);
    expect(detail.body.comptage.emplacements).toHaveLength(10);
    expect(detail.body.comptage.emplacements[0]).toMatchObject({ code: 'N-B-04-101', compte: false });
    expect(JSON.stringify(detail.body.comptage)).not.toContain('Chaise');

    const [c1, c2, c3, , c5] = await Promise.all(chaises().map(qrOf));
    const unknown = generateQrCode('A');
    const L = async (code: string) => (await loc(code)).qr_code;
    // emplacement hors de cette mission
    expect(await field(op, { type: 'LOCATION_COUNT', payload: { missionId: missions[0]!, locationQr: await L('N-B-S01'), qrs: [] } })).toMatchObject({ status: 'ERROR', code: 'HORS_INVENTAIRE' });

    const counted = new Set<string>();
    const countAll = async (missionId: string, special: Record<string, string[]>) => {
      const d = await get(op, `/field/missions/${missionId}`);
      for (const e of d.body.comptage.emplacements as { id: string; code: string; qrCode: string }[]) {
        const present = special[e.code] ?? (await sys<{ qr_code: string }>(`SELECT qr_code FROM article WHERE emplacement_courant_id = $1 AND statut IN ('EN_STOCK','RESERVE')`, [e.id])).rows.map((x) => x.qr_code);
        const r = ok(await field(op, { type: 'LOCATION_COUNT', payload: { missionId, locationQr: e.qrCode, qrs: present } }));
        counted.add(e.code);
        if (e.code === 'N-B-04-103') expect(r).toMatchObject({ attendus: 1, trouves: 2, ecarts: 2 });
      }
    };
    // 102 : chaise 2 absente ; 103 : chaise 3, plus la chaise 5 (rangée en 201 d'après le système) et une étiquette inconnue
    // la chaise 5 n'est évidemment plus en 201
    await countAll(missions[0]!, { 'N-B-04-101': [c1!], 'N-B-04-102': [], 'N-B-04-103': [c3!, c5!, unknown], 'N-B-04-201': [] });
    // recompter un emplacement remplace son comptage : toujours un seul manquant en 102
    ok(await field(op, { type: 'LOCATION_COUNT', payload: { missionId: missions[0]!, locationQr: await L('N-B-04-102'), qrs: [] } }));
    expect((await sys<{ statut: string }>('SELECT statut FROM mission WHERE id = $1', [missions[0]])).rows[0]!.statut).toBe('TERMINEE');
    await countAll(missions[1]!, {});
    expect((await sys<{ statut: string }>('SELECT statut FROM inventaire WHERE id = $1', [invId])).rows[0]!.statut).toBe('EN_COURS');
    await countAll(missions[2]!, {});
    expect(counted.size).toBe(26);
    expect(c2).toBeTruthy();

    const inv = await get(u().superAdmin.email, `/bo/inventaires/${invId}`);
    expect(inv.body.statut).toBe('A_ARBITRER');
    const types = inv.body.ecarts.map((x: { type: string; emplacementCode: string }) => `${x.type} ${x.emplacementCode}`).sort();
    expect(types).toEqual(['DEPLACE N-B-04-103', 'INCONNU N-B-04-103', 'MANQUANT N-B-04-102', 'MANQUANT N-B-04-201']);
    const notif = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE modele = 'INVENTAIRE_A_ARBITRER' AND variables->>'inventaireId' = $1`, [invId]);
    expect(notif.rows[0]!.n).toBeGreaterThanOrEqual(1);
    // rien n'a bougé en stock tant que personne n'a arbitré
    expect((await locOf(chaises()[1]!)).statut).toBe('EN_STOCK');
  });

  it('le Back-Office arbitre chaque écart : correction tracée ou écart ignoré, puis clôture', async () => {
    const admin = u().superAdmin.email;
    const inv = (await get(admin, `/bo/inventaires/${invId}`)).body;
    const find = (type: string, code: string) => inv.ecarts.find((x: { type: string; emplacementCode: string }) => x.type === type && x.emplacementCode === code).id;
    const decide = (id: string, decision: string, motif = 'Constat du comptage') => post(admin, `/bo/inventaires/${invId}/ecarts/${id}`, { decision, motif });

    expect((await decide(find('MANQUANT', 'N-B-04-102'), 'CORRIGE')).status).toBe(422);
    expect((await post(admin, `/bo/inventaires/${invId}/ecarts/${find('MANQUANT', 'N-B-04-102')}`, { decision: 'PERDU', motif: '' })).status).toBe(400);
    expect((await decide(find('MANQUANT', 'N-B-04-102'), 'PERDU', 'Introuvable après recherche dans l’allée')).status).toBe(201);
    expect(await locOf(chaises()[1]!)).toMatchObject({ statut: 'PERDU', emplacement_courant_id: null });
    const mv = await sys<{ motif: string; type: string }>(`SELECT motif, type FROM mouvement WHERE article_id = $1 ORDER BY horodatage_serveur DESC LIMIT 1`, [chaises()[1]]);
    expect(mv.rows[0]).toMatchObject({ type: 'AJUSTEMENT' });
    expect(mv.rows[0]!.motif).toMatch(/^Inventaire INV-.* : manquant déclaré perdu : Introuvable/);

    const in103 = (await loc('N-B-04-103')).id;
    expect((await decide(find('DEPLACE', 'N-B-04-103'), 'CORRIGE')).status).toBe(201);
    expect((await locOf(chaises()[4]!)).emplacement_courant_id).toBe(in103);
    // la chaise 5 a été corrigée : son « manquant » en 201 n'est plus d'actualité
    const r = await decide(find('MANQUANT', 'N-B-04-201'), 'PERDU');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STOCK_A_CHANGE');
    expect((await decide(find('MANQUANT', 'N-B-04-201'), 'IGNORE', 'Chaise retrouvée en 103')).status).toBe(201);
    const last = await decide(find('INCONNU', 'N-B-04-103'), 'IGNORE', 'Étiquette d’un autre dépôt');
    expect(last.body).toMatchObject({ restants: 0, statut: 'CLOS' });
    expect((await decide(find('INCONNU', 'N-B-04-103'), 'IGNORE')).status).toBe(409);
    const list = await get(admin, '/bo/inventaires?statut=CLOS');
    expect(list.body.items[0]).toMatchObject({ id: invId, ecarts: 4, aArbitrer: 0 });
  });

  it('un inventaire en cours peut être annulé : ses missions aussi', async () => {
    const zr = (await sys<{ id: string }>(`SELECT id FROM zone WHERE code = 'R'`)).rows[0]!.id;
    const r = await post(u().superAdmin.email, '/bo/inventaires', { zoneId: zr });
    expect(r.status).toBe(201);
    expect((await post(u().superAdmin.email, `/bo/inventaires/${r.body.id}/annuler`, { motif: 'Lancé par erreur' })).status).toBe(201);
    const m = await sys<{ statut: string }>('SELECT statut FROM mission WHERE id = ANY($1)', [r.body.missions]);
    expect(m.rows.every((x) => x.statut === 'ANNULEE')).toBe(true);
    expect((await post(u().superAdmin.email, '/bo/inventaires', { zoneId: zr })).status).toBe(201);
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickupFingerprint, uuidv7, type FieldAction, type SyncResult } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Objets installés chez le client : vue par site, retour au dépôt, transfert de site à site. */
let t: TestContext;
let owner: pg.Client;
type Client = Awaited<ReturnType<typeof as>>;
const as = async (email: string) => {
  const token = await t.login(email);
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (p: string) => t.http().get(`/api/v1${p}`).set(auth),
    post: (p: string, body: unknown = {}) => t.http().post(`/api/v1${p}`).set(auth).send(body as object),
  };
};

let clock = Date.parse('2027-01-20T07:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
async function one(c: Client, action: FieldAction) {
  const res = await c.post('/field/sync', { deviceId: 'terminal-test', deviceTime: new Date().toISOString(), actions: [{ key: uuidv7(), at: tick(), action }] });
  if (res.status !== 200) throw new Error(`sync ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.results[0] as SyncResult;
}
const ok = (r: SyncResult) => {
  if (r.status !== 'OK') throw new Error(`${r.code} : ${r.message}`);
  return r.data as Record<string, unknown>;
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

async function sys<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
  try {
    const r = await owner.query<T>(sql, params);
    await owner.query('COMMIT');
    return r;
  } catch (e) {
    await owner.query('ROLLBACK');
    throw e;
  }
}

let admin: Client;
let client: Client;
let dispatcher: Client;
let driver: Client;
let onSite: { id: string; libelle: string; qrCode: string }[];

async function planned(commandeId: string) {
  expect((await dispatcher.post(`/orders/${commandeId}/plan`, { date: '2027-01-20' })).status).toBe(200);
  const m = (await dispatcher.get('/missions')).body.find((x: { commandeId: string }) => x.commandeId === commandeId) as { id: string; type: string };
  expect(m.type).toBe('COLLECTE');
  expect((await dispatcher.post(`/missions/${m.id}/assign`, { assigneA: t.data.users.driver.id, vehiculeId: t.data.vehicules.vul12 })).status).toBe(200);
  return m.id;
}

function pickup(missionId: string, arts: { id: string; libelle: string; qrCode: string }[]) {
  const p = {
    missionId,
    blId: uuidv7(),
    articles: arts.map((a) => ({ articleId: a.id, qr: a.qrCode, libelle: a.libelle, photos: [] })),
    signataire: { nom: 'Mme Durand', qualite: 'Responsable du site' },
    signatureSvg: SVG,
    signedAt: '2027-01-20T09:10:00Z',
  };
  return { type: 'PICKUP_SIGN' as const, payload: { ...p, empreinte: pickupFingerprint(p) } };
}

beforeAll(async () => {
  t = await bootstrap();
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  admin = await as(t.data.users.superAdmin.email);
  client = await as(t.data.users.b2bAdmin.email);
  dispatcher = await as(t.data.users.dispatcher.email);
  driver = await as(t.data.users.driver.email);
  const quai = (await sys<{ id: string }>(`SELECT e.id FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.type = 'RECEPTION' AND e.adressable LIMIT 1`)).rows[0]!.id;
  const csv = [
    'Désignation;Référence;Client;Projet;Situation;Quantité;Couleur;Emplacement d’origine;Description',
    'Canapé d’accueil;MS-10;Promotion Horizon SAS;Stand de vente Résidence Les Tilleuls;chez le client;1;Gris foncé;G3 M;Tissu bouclette',
    'Chaise visiteur;MS-11;Promotion Horizon SAS;Stand de vente Résidence Les Tilleuls;chez le client;3;Noir;;',
    'Totem PLV;MS-12;Promotion Horizon SAS;;en stock;1;Blanc;H2 B;',
  ].join('\n');
  const res = await admin.post('/bo/reprise/articles', { csv, depotId: t.data.depotId, emplacementParDefautId: quai, dryRun: false });
  expect(res.body.cree).toBe(5);
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('couleur et emplacement d’origine repris de l’ancien logiciel', () => {
  it('enregistrés sur la fiche et trouvables par la recherche', async () => {
    const r = await sys<{ couleur: string; emplacement_origine: string | null; description: string | null }>(
      `SELECT couleur, emplacement_origine, description FROM article WHERE reference_interne = 'MS-10'`,
    );
    expect(r.rows[0]).toEqual({ couleur: 'Gris foncé', emplacement_origine: 'G3 M', description: 'Tissu bouclette' });
    const search = await admin.get('/articles?q=H2%20B');
    expect(search.body.items.map((a: { libelle: string }) => a.libelle)).toContain('Totem PLV');
  });
});

describe('objets installés chez le client', () => {
  it('le client les voit à part, avec leur site', async () => {
    const res = await client.get('/articles?statut=RESTITUE&limite=200');
    expect(res.status).toBe(200);
    onSite = res.body.items.filter((a: { libelle: string }) => /Canapé d’accueil|Chaise visiteur/.test(a.libelle));
    expect(onSite).toHaveLength(4);
    expect(onSite.every((a) => (a as unknown as { projetId: string }).projetId === t.data.projets.tilleuls)).toBe(true);
    expect(onSite.find((a) => a.libelle === 'Canapé d’accueil')).toMatchObject({ couleur: 'Gris foncé' });
    // la liste par défaut (au dépôt) ne les montre pas
    const depot = await client.get('/articles?limite=200');
    expect(depot.body.items.some((a: { libelle: string }) => a.libelle === 'Canapé d’accueil')).toBe(false);
  });

  it('retour au dépôt : objets connus repris avec leur étiquette, un manquant signalé, puis réception', async () => {
    const totem = (await client.get('/articles?q=Totem')).body.items[0] as { id: string };
    const refus = await client.post('/collections', {
      nature: 'RETOUR',
      articleIds: [totem.id],
      projetId: t.data.projets.tilleuls,
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-20',
      description: 'Retour',
    });
    expect(refus.status).toBe(422);
    expect(refus.body.error.code).toBe('PAS_CHEZ_LE_CLIENT');

    const [a, b] = onSite.filter((x) => x.libelle.startsWith('Chaise'));
    const res = await client.post('/collections', {
      nature: 'RETOUR',
      articleIds: [a!.id, b!.id],
      projetId: t.data.projets.tilleuls,
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-20',
      description: 'Retour au dépôt de 2 objets',
      contactSite: { nom: 'Mme Durand', telephone: '0601020304' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ natureCollecte: 'RETOUR', nbArticles: 2 });
    // un objet déjà demandé ne peut pas l'être deux fois
    const twice = await client.post('/collections', {
      nature: 'RETOUR',
      articleIds: [a!.id],
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-20',
      description: 'Encore',
    });
    expect(twice.status).toBe(409);

    const missionId = await planned(res.body.id);
    const detail = await driver.get(`/field/missions/${missionId}`);
    expect(detail.body.commande.natureCollecte).toBe('RETOUR');
    expect(detail.body.lignes.map((l: { articleId: string }) => l.articleId).sort()).toEqual([a!.id, b!.id].sort());

    const data = ok(await one(driver, pickup(missionId, [a!])));
    expect(data).toMatchObject({ nbArticles: 1, manquants: 1 });
    const arts = await sys<{ id: string; statut: string; commande_collecte_id: string | null }>(
      'SELECT id, statut, commande_collecte_id FROM article WHERE id = ANY($1)',
      [[a!.id, b!.id]],
    );
    expect(arts.rows.find((x) => x.id === a!.id)).toMatchObject({ statut: 'EN_RECEPTION', commande_collecte_id: res.body.id });
    expect(arts.rows.find((x) => x.id === b!.id)).toMatchObject({ statut: 'RESTITUE', commande_collecte_id: null });
    const order = await client.get(`/orders/${res.body.id}`);
    expect(order.body.statut).toBe('COLLECTEE');
    expect(order.body.lignes.find((l: { articleId: string }) => l.articleId === b!.id).statutLigne).toBe('MANQUANTE');
    // l'objet manquant redevient disponible pour une autre demande
    const again = await client.post('/collections', {
      nature: 'RETOUR',
      articleIds: [b!.id],
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-21',
      description: 'Le dernier',
    });
    expect(again.status).toBe(201);
    // la réception du dépôt l'attend, avec son QR d'origine
    const operator = await as(t.data.users.operator.email);
    const expected = (await operator.get('/field/receptions')).body as { commandeId: string; articles: { id: string }[] }[];
    expect(expected.find((r) => r.commandeId === res.body.id)?.articles.map((x) => x.id)).toEqual([a!.id]);
  });

  it('transfert de site à site : chargé chez le client, déposé et rattaché au nouveau site', async () => {
    const canape = onSite.find((x) => x.libelle === 'Canapé d’accueil')!;
    const sansDestination = await client.post('/collections', {
      nature: 'TRANSFERT',
      articleIds: [canape.id],
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-20',
      description: 'Transfert',
    });
    expect(sansDestination.status).toBe(400);
    const res = await client.post('/collections', {
      nature: 'TRANSFERT',
      articleIds: [canape.id],
      projetId: t.data.projets.tilleuls,
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      destination: { projetId: t.data.projets.jardins, adresse: { libelle: '5 rue des Jardins, 92170 Vanves' } },
      dateSouhaitee: '2027-01-20',
      description: 'Transfert de 1 objet vers Bureau témoin Les Jardins',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ natureCollecte: 'TRANSFERT', destination: { libelle: '5 rue des Jardins, 92170 Vanves' } });
    const missionId = await planned(res.body.id);

    ok(await one(driver, pickup(missionId, [canape])));
    let a = (await sys<{ statut: string; projet_id: string }>('SELECT statut, projet_id FROM article WHERE id = $1', [canape.id])).rows[0]!;
    expect(a.statut).toBe('EN_TRANSIT');
    // la mission reste ouverte jusqu'au dépôt sur le nouveau site
    const m = await sys<{ statut: string }>('SELECT statut FROM mission WHERE id = $1', [missionId]);
    expect(m.rows[0]!.statut).not.toBe('TERMINEE');

    const drop = ok(await one(driver, { type: 'TRANSFER_DROP', payload: { missionId, recuPar: 'M. Leroy' } }));
    expect(drop).toMatchObject({ nbArticles: 1, statut: 'LIVREE' });
    a = (await sys<{ statut: string; projet_id: string }>('SELECT statut, projet_id FROM article WHERE id = $1', [canape.id])).rows[0]!;
    expect(a).toEqual({ statut: 'RESTITUE', projet_id: t.data.projets.jardins });
    const mv = await sys<{ types: string }>(`SELECT string_agg(type::text, ',' ORDER BY horodatage_terminal) AS types FROM mouvement WHERE article_id = $1`, [canape.id]);
    expect(mv.rows[0]!.types).toBe('RECEPTION,LIVRAISON,CHARGEMENT,LIVRAISON');
    expect((await client.get(`/orders/${res.body.id}`)).body.statut).toBe('LIVREE');
  });

  it('un transfert refuse un objet qui n’était pas demandé', async () => {
    const chaise = onSite.filter((x) => x.libelle.startsWith('Chaise'))[2]!;
    const autre = onSite.filter((x) => x.libelle.startsWith('Chaise'))[0]!;
    const res = await client.post('/collections', {
      nature: 'TRANSFERT',
      articleIds: [chaise.id],
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      destination: { adresse: { libelle: '5 rue des Jardins, 92170 Vanves' } },
      dateSouhaitee: '2027-01-20',
      description: 'Transfert',
    });
    const missionId = await planned(res.body.id);
    const r = await one(driver, pickup(missionId, [chaise, autre]));
    expect(r).toMatchObject({ status: 'ERROR', code: 'HORS_TRANSFERT' });
  });
});

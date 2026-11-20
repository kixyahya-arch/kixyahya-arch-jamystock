import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blFingerprint, uuidv7, type BlSignPayload, type FieldAction, type SyncResult } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

/** Lot 3 : modèles de panier (CMD-08), restitution partielle d'une UM (CMD-09), dépôt sans signature (LIV-05), litiges (SUI-04). */
let t: TestContext;
let owner: pg.Client;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await auth(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const del = async (email: string, path: string) => t.http().delete(`/api/v1${path}`).set('Authorization', await auth(email));
const putImage = async (email: string, path: string, data: Buffer, type = 'image/jpeg') =>
  t.http().put(`/api/v1${path}`).set('Authorization', await auth(email)).set('Content-Type', type).send(data);

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

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const u = () => t.data.users;
const qrOf = async (id: string) => (await sys<{ qr_code: string }>('SELECT qr_code FROM article WHERE id = $1', [id])).rows[0]!.qr_code;

beforeAll(async () => {
  t = await bootstrap({ PUBLIC_URL: 'https://app.jamystock.test' });
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('modèles de panier (CMD-08)', () => {
  const ids = () => t.data.articles.tilleuls.slice(1, 3); // deux bureaux d'accueil
  let modele: string;

  it('enregistre le panier en cours comme modèle', async () => {
    const admin = u().b2bAdmin.email;
    expect((await post(admin, '/cart/items', { articleIds: ids(), projetId: t.data.projets.tilleuls })).status).toBe(201);
    const r = await post(admin, '/me/cart-templates', { nom: 'Kit accueil', projetId: t.data.projets.tilleuls });
    expect(r.status).toBe(201);
    expect(r.body.nbArticles).toBe(2);
    modele = r.body.id;
    expect((await post(admin, '/me/cart-templates', { nom: 'kit ACCUEIL', projetId: t.data.projets.tilleuls })).status).toBe(409);
    // visible des utilisateurs du projet, pas d'un autre client
    const list = await get(u().b2bUser.email, '/me/cart-templates');
    expect(list.body.items).toEqual([expect.objectContaining({ nom: 'Kit accueil', nbArticles: 2, nbDisponibles: 2, supprimable: false })]);
    expect((await get(u().otherB2bAdmin.email, '/me/cart-templates')).body.items).toEqual([]);
  });

  it('recommande en un clic et signale les articles indisponibles', async () => {
    const admin = u().b2bAdmin.email;
    for (const id of ids()) await del(admin, `/cart/items/${id}?projetId=${t.data.projets.tilleuls}`);
    await sys(`UPDATE article SET statut = 'EN_TRANSIT' WHERE id = $1`, [ids()[1]]);
    const r = await post(admin, `/me/cart-templates/${modele}/use`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ajoutes: 1, indisponibles: [{ id: ids()[1], raison: 'en cours de livraison' }] });
    const cart = await get(admin, `/cart?projetId=${t.data.projets.tilleuls}`);
    expect(cart.body.lignes.map((l: { articleId: string }) => l.articleId)).toEqual([ids()[0]]);
    // déjà au panier : ni rajouté ni signalé
    expect((await post(admin, `/me/cart-templates/${modele}/use`)).body).toMatchObject({ ajoutes: 0, indisponibles: [{ id: ids()[1] }] });
    await sys(`UPDATE article SET statut = 'EN_STOCK' WHERE id = $1`, [ids()[1]]);
    await del(admin, `/cart/items/${ids()[0]}?projetId=${t.data.projets.tilleuls}`);
  });

  it('seul l’auteur ou un administrateur supprime un modèle', async () => {
    expect((await del(u().b2bUser.email, `/me/cart-templates/${modele}`)).status).toBe(403);
    expect((await del(u().b2bAdmin.email, `/me/cart-templates/${modele}`)).status).toBe(200);
  });
});

describe('restitution partielle d’une palette, dépôt sans signature, puis litige', () => {
  const chaises = () => t.data.articles.tilleuls.slice(5, 9); // 4 chaises sur une même palette
  const demandees = () => chaises().slice(0, 2);
  let orderId: string;
  let missions: { id: string; type: string }[];
  let blId: string;
  let litige: string;

  it('commande de 2 chaises sur une palette de 4 : mission de dégroupage avant la préparation (CMD-09)', async () => {
    const um = uuidv7();
    const loc = (await sys<{ emplacement_courant_id: string }>('SELECT emplacement_courant_id FROM article WHERE id = $1', [chaises()[0]])).rows[0]!.emplacement_courant_id;
    await sys(`INSERT INTO unite_manutention (id, tenant_id, entreprise_id, qr_code, type, emplacement_courant_id) VALUES ($1,$2,$3,'U-TEST-PAL1','PALETTE',$4)`, [
      um, t.data.tenantId, t.data.entreprises.promoteur, loc,
    ]);
    await sys('UPDATE article SET um_courante_id = $2, emplacement_courant_id = $3 WHERE id = ANY($1::uuid[])', [chaises(), um, loc]);

    const admin = u().b2bAdmin.email;
    const cart = await post(admin, '/cart/items', { articleIds: demandees(), projetId: t.data.projets.tilleuls });
    orderId = cart.body.id;
    expect(cart.body.lignes.map((l: { umTotal: number }) => l.umTotal)).toEqual([4, 4]);
    const sub = await post(admin, `/orders/${orderId}/submit`, {
      type: 'LIVRAISON',
      adresse: { libelle: '3 avenue du Chantier, Boulogne' },
      contactSite: { nom: 'Chef de chantier', telephone: '0600000000' },
      dateSouhaitee: '2027-01-18',
      depotSansSignature: true,
    });
    expect(sub.status).toBe(200);
    expect(sub.body.depotSansSignature).toBe(true);
    expect((await post(u().dispatcher.email, `/orders/${orderId}/plan`, { date: '2027-01-18' })).status).toBe(200);
    missions = ((await get(u().dispatcher.email, '/missions')).body as { id: string; type: string; commandeId: string }[]).filter((m) => m.commandeId === orderId);
    expect(missions.map((m) => m.type).sort()).toEqual(['DEGROUPAGE', 'LIVRAISON', 'PREPARATION']);
    for (const m of missions) {
      const r = await post(u().dispatcher.email, `/missions/${m.id}/assign`, m.type === 'LIVRAISON' ? { assigneA: u().driver.id, vehiculeId: t.data.vehicules.vul12 } : { assigneA: u().operator.id });
      expect(r.status).toBe(200);
    }
  });

  it('l’opérateur sort les 2 chaises de la palette ; les 2 autres y restent', async () => {
    const op = u().operator.email;
    const deg = missions.find((m) => m.type === 'DEGROUPAGE')!.id;
    const prep = missions.find((m) => m.type === 'PREPARATION')!.id;
    const detail = await get(op, `/field/missions/${deg}`);
    expect(detail.body.lignes.every((l: { umADegrouper: string; resteSurUm: boolean }) => l.umADegrouper === 'U-TEST-PAL1' && l.resteSurUm)).toBe(true);

    const q = await Promise.all(demandees().map(qrOf));
    expect(await field(op, { type: 'PICK', payload: { missionId: prep, articleQr: q[0]! } })).toMatchObject({ status: 'ERROR', code: 'DEGROUPAGE_REQUIS' });
    expect(await field(op, { type: 'UM_SPLIT', payload: { missionId: deg, articleQr: await qrOf(chaises()[3]!) } })).toMatchObject({ status: 'ERROR', code: 'HORS_DEGROUPAGE' });
    expect(ok(await field(op, { type: 'UM_SPLIT', payload: { missionId: deg, articleQr: q[0]! } }))).toMatchObject({ restants: 1, termine: false });
    expect(ok(await field(op, { type: 'UM_SPLIT', payload: { missionId: deg, articleQr: q[1]! } }))).toMatchObject({ restants: 0, termine: true });

    const on = await sys<{ id: string }>(`SELECT id FROM article WHERE um_courante_id = (SELECT id FROM unite_manutention WHERE qr_code = 'U-TEST-PAL1') ORDER BY id`);
    expect(on.rows.map((r) => r.id).sort()).toEqual(chaises().slice(2).sort());
    expect((await sys<{ statut: string }>('SELECT statut FROM mission WHERE id = $1', [deg])).rows[0]!.statut).toBe('TERMINEE');

    for (const qr of q) ok(await field(op, { type: 'PICK', payload: { missionId: prep, articleQr: qr } }));
    ok(await field(op, { type: 'PICK_COMPLETE', payload: { missionId: prep } }));
    for (const qr of q) ok(await field(op, { type: 'LOAD', payload: { missionId: prep, articleQr: qr } }));
  });

  it('destinataire absent : dépôt sans signature avec 3 photos, BL « non signé, déposé » (LIV-05)', async () => {
    const drv = u().driver.email;
    const liv = missions.find((m) => m.type === 'LIVRAISON')!.id;
    ok(await field(drv, { type: 'DEPART', payload: { missionId: liv } }));
    expect((await get(drv, `/field/missions/${liv}`)).body.commande.depotSansSignature).toBe(true);

    blId = uuidv7();
    const photos = [uuidv7(), uuidv7(), uuidv7()];
    const base: Omit<BlSignPayload, 'empreinte'> = {
      missionId: liv,
      blId,
      livres: demandees(),
      refuses: [],
      reserves: [],
      signataire: { nom: '', qualite: '' },
      signatureSvg: '',
      signedAt: new Date().toISOString(),
      depot: { lieu: 'Dans le bungalow de chantier, porte de gauche', photoIds: photos.slice(0, 2) },
    };
    // le contrôle de forme refuse moins de 3 photos avant même la règle métier
    const two = await post(drv, '/field/sync', { deviceId: 'terminal-test', deviceTime: new Date().toISOString(), actions: [{ key: uuidv7(), at: new Date().toISOString(), action: { type: 'BL_SIGN', payload: { ...base, empreinte: blFingerprint(base) } } }] });
    expect(two.status).toBe(400);

    const p = { ...base, depot: { ...base.depot!, photoIds: photos } };
    // sans l'accord du client, pas de dépôt
    await sys('UPDATE commande SET depot_sans_signature = false WHERE id = $1', [orderId]);
    expect(await field(drv, { type: 'BL_SIGN', payload: { ...p, empreinte: blFingerprint(p) } })).toMatchObject({ status: 'ERROR', code: 'DEPOT_NON_AUTORISE' });
    await sys('UPDATE commande SET depot_sans_signature = true WHERE id = $1', [orderId]);

    const r = ok(await field(drv, { type: 'BL_SIGN', payload: { ...p, empreinte: blFingerprint(p) } }));
    expect(r).toMatchObject({ statutCommande: 'LIVREE' });
    for (const ph of photos) expect((await putImage(drv, `/field/photos/${ph}`, JPEG)).status).toBe(200);
    const bl = await sys<{ statut: string; lieu_depot: string; signataire_nom: string | null }>('SELECT statut, lieu_depot, signataire_nom FROM bon_de_livraison WHERE id = $1', [blId]);
    expect(bl.rows[0]).toMatchObject({ statut: 'NON_SIGNE_DEPOSE', lieu_depot: 'Dans le bungalow de chantier, porte de gauche', signataire_nom: null });

    const admin = u().b2bAdmin.email;
    const docs = await get(admin, '/me/documents?type=BL');
    expect(docs.body.items.find((d: { id: string }) => d.id === blId)).toMatchObject({ nonSigne: true });
    const pdf = await t.http().get(`/api/v1/me/documents/bl/${blId}/pdf`).set('Authorization', await auth(admin));
    expect(pdf.status).toBe(200);
    const d = await get(admin, `/me/disputes/delivery/${orderId}`);
    expect(d.body.livraison).toMatchObject({ nonSigne: true, lieuDepot: 'Dans le bungalow de chantier, porte de gauche', signalementPossible: true });
    expect(d.body.livraison.photos).toHaveLength(3);
    const mail = await sys<{ variables: { nonSigne?: boolean } }>(`SELECT variables FROM notification WHERE modele = 'LIVRAISON_EFFECTUEE' AND variables->>'blId' = $1 AND canal = 'EMAIL'`, [blId]);
    expect(mail.rows[0]!.variables.nonSigne).toBe(true);
  });

  it('le client signale un problème dans les 48 h, photos jointes ; ticket côté Back-Office (SUI-04)', async () => {
    const user = u().b2bUser.email;
    const r = await post(user, '/me/disputes', { commandeId: orderId, motif: 'CASSE', description: 'Un pied de chaise est cassé à la livraison.', articleIds: [demandees()[0]] });
    expect(r.status).toBe(201);
    expect(r.body.numero).toMatch(/^LIT-\d{4}-\d{6}$/);
    litige = r.body.id;
    expect((await post(user, '/me/disputes', { commandeId: orderId, motif: 'AUTRE', description: 'Un deuxième signalement ici.' })).status).toBe(409);
    expect((await post(user, '/me/disputes', { commandeId: orderId, motif: 'CASSE', description: 'Bien hors livraison ici.', articleIds: [chaises()[3]] })).status).toBe(422);

    const photo = uuidv7();
    expect((await putImage(user, `/me/disputes/${litige}/photos/${photo}`, JPEG)).status).toBe(200);
    expect((await putImage(user, `/me/disputes/${litige}/photos/${uuidv7()}`, Buffer.from('pas une image'))).status).toBe(422);
    expect((await putImage(u().b2bAdmin.email, `/me/disputes/${litige}/photos/${uuidv7()}`, JPEG)).status).toBe(403);

    const mine = await get(user, `/me/disputes/delivery/${orderId}`);
    expect(mine.body.litiges[0]).toMatchObject({ statut: 'OUVERT', motif: 'CASSE', articles: [{ id: demandees()[0] }] });
    expect(mine.body.litiges[0].photos).toHaveLength(1);
    expect((await get(u().otherB2bAdmin.email, `/me/disputes/delivery/${orderId}`)).body.livraison).toBeNull();

    const staff = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE modele = 'LITIGE_OUVERT' AND variables->>'litigeId' = $1`, [litige]);
    expect(staff.rows[0]!.n).toBeGreaterThanOrEqual(2);
    const bo = await get(u().dispatcher.email, '/bo/disputes?statut=A_TRAITER');
    expect(bo.body.items[0]).toMatchObject({ id: litige, statut: 'OUVERT', nbPhotos: 1 });
    const detail = await get(u().dispatcher.email, `/bo/disputes/${litige}`);
    expect(detail.body.livraison).toMatchObject({ id: blId, statut: 'NON_SIGNE_DEPOSE' });
  });

  it('le Back-Office répond ; un geste commercial est déduit de la prochaine facture', async () => {
    expect((await post(u().dispatcher.email, `/bo/disputes/${litige}/resolve`, { statut: 'RESOLU', reponse: 'Chaise remplacée', gesteCents: 5000 })).status).toBe(403);
    expect((await post(u().dispatcher.email, `/bo/disputes/${litige}/resolve`, { statut: 'EN_COURS', reponse: 'Nous vérifions avec le chauffeur.' })).status).toBe(200);
    // une fois pris en charge, le client n'ajoute plus de photo
    expect((await putImage(u().b2bUser.email, `/me/disputes/${litige}/photos/${uuidv7()}`, JPEG)).status).toBe(409);
    const r = await post(u().superAdmin.email, `/bo/disputes/${litige}/resolve`, { statut: 'RESOLU', reponse: 'Pied remplacé, avec nos excuses.', gesteCents: 5000 });
    expect(r.status).toBe(200);
    expect((await post(u().superAdmin.email, `/bo/disputes/${litige}/resolve`, { statut: 'REJETE', reponse: 'Trop tard' })).status).toBe(409);
    const p = await sys<{ prix_unitaire_ht_cents: number }>(`SELECT prix_unitaire_ht_cents FROM prestation_a_facturer WHERE code = 'GESTE_COMMERCIAL' AND source_id = $1`, [litige]);
    expect(p.rows[0]!.prix_unitaire_ht_cents).toBe(-5000);
    const n = await sys<{ canal: string }>(`SELECT canal FROM notification WHERE modele = 'LITIGE_TRAITE' AND destinataire_id = $1 AND variables->>'statut' = 'RESOLU' ORDER BY canal`, [u().b2bUser.id]);
    expect(n.rows.map((x) => x.canal)).toEqual(['EMAIL', 'IN_APP']);
    const mine = await get(u().b2bUser.email, `/me/disputes?commandeId=${orderId}`);
    expect(mine.body.items[0]).toMatchObject({ statut: 'RESOLU', reponse: 'Pied remplacé, avec nos excuses.', gesteCents: 5000 });
  });

  it('au-delà de 48 h, le signalement en ligne est fermé', async () => {
    await sys(`UPDATE bon_de_livraison SET signe_le = now() - interval '49 hours' WHERE id = $1`, [blId]);
    const r = await post(u().b2bAdmin.email, '/me/disputes', { commandeId: orderId, motif: 'AUTRE', description: 'Signalement tardif sur la livraison.' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DELAI_DEPASSE');
    expect((await get(u().b2bAdmin.email, `/me/disputes/delivery/${orderId}`)).body.livraison.signalementPossible).toBe(false);
  });
});

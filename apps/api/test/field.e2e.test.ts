import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blFingerprint, pickupFingerprint, uuidv7, type FieldAction, type SyncResult } from '@jamystock/domain';
import { bootstrap, type TestContext } from './setup.js';

/** Les trois parcours critiques de la §4, joués comme le ferait l'app terrain (file d'actions). */
let t: TestContext;
type Client = Awaited<ReturnType<typeof as>>;
const as = async (email: string) => {
  const token = await t.login(email);
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (p: string) => t.http().get(`/api/v1${p}`).set(auth),
    post: (p: string, body: unknown = {}) => t.http().post(`/api/v1${p}`).set(auth).send(body as object),
    put: (p: string, data: Buffer, type: string) => t.http().put(`/api/v1${p}`).set(auth).set('Content-Type', type).send(data),
  };
};

let clock = Date.parse('2027-01-18T07:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
const env = (action: FieldAction, at = tick()) => ({ key: uuidv7(), at, action });

async function sync(c: Client, actions: ReturnType<typeof env>[], deviceTime = new Date().toISOString()) {
  const res = await c.post('/field/sync', { deviceId: 'terminal-test', deviceTime, actions });
  if (res.status !== 200) throw new Error(`sync ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { results: SyncResult[]; clockSkewMs: number };
}
async function one(c: Client, action: FieldAction) {
  const { results } = await sync(c, [env(action)]);
  return results[0]!;
}
const ok = (r: SyncResult) => {
  if (r.status !== 'OK') throw new Error(`${r.code} : ${r.message}`);
  return r.data as Record<string, unknown>;
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

let operator: Client;
let driver: Client;
let dispatcher: Client;
let locations: { qrCode: string; code: string; typeZone: string }[];
const loc = (code: string) => locations.find((l) => l.code === code)!.qrCode;

async function blankQrs(type: 'A' | 'U', count: number): Promise<string[]> {
  const res = await operator.post('/labels/blank', { type, count });
  expect(res.status).toBe(201);
  return res.body.codes.map((c: { code: string }) => c.code);
}

async function missionsOf(commandeId: string) {
  const res = await dispatcher.get('/missions');
  return res.body.filter((m: { commandeId: string }) => m.commandeId === commandeId) as { id: string; type: string }[];
}

beforeAll(async () => {
  t = await bootstrap();
  operator = await as(t.data.users.operator.email);
  driver = await as(t.data.users.driver.email);
  dispatcher = await as(t.data.users.dispatcher.email);
  const boot = await operator.get('/field/bootstrap');
  locations = boot.body.emplacements;
});
afterAll(async () => {
  await t.app.close();
});

describe('§4.1 collecte puis entrée en stock avec photo et QR', () => {
  let commandeId: string;
  let qrs: string[];
  let palette: string;
  const enleve = { etiquete: uuidv7(), sansEtiquette: uuidv7() };

  it('collecte planifiée et affectée au chauffeur', async () => {
    const b2c = await as(t.data.users.b2c.email);
    const res = await b2c.post('/collections', { adresse: { libelle: '8 rue des Lilas, 75020 Paris' }, dateSouhaitee: '2027-01-20', description: 'Salon' });
    commandeId = res.body.id;
    await dispatcher.post(`/orders/${commandeId}/plan`, { date: '2027-01-20' });
    const [m] = await missionsOf(commandeId);
    expect(m!.type).toBe('COLLECTE');
    const a = await dispatcher.post(`/missions/${m!.id}/assign`, { assigneA: t.data.users.driver.id, vehiculeId: t.data.vehicules.vul12 });
    expect(a.status).toBe(200);
    // un opérateur ne peut pas recevoir une mission de transport
    expect((await dispatcher.post(`/missions/${m!.id}/assign`, { assigneA: t.data.users.operator.id })).status).toBe(422);
  });

  it('BL d’enlèvement signé chez le client (LIV-06), empreinte vérifiée', async () => {
    qrs = await blankQrs('A', 4);
    palette = (await blankQrs("U", 1))[0]!;
    const [m] = await missionsOf(commandeId);
    const boot = await driver.get('/field/bootstrap');
    expect(boot.body.missions.map((x: { id: string }) => x.id)).toContain(m!.id);

    const base = {
      missionId: m!.id,
      blId: uuidv7(),
      articles: [
        { articleId: enleve.etiquete, qr: qrs[0]!, libelle: 'Canapé 3 places', photos: [{ photoId: uuidv7() }] },
        { articleId: enleve.sansEtiquette, libelle: 'Lampadaire', photos: [] },
      ],
      signataire: { nom: 'Camille Martin', qualite: 'Cliente' },
      signatureSvg: SVG,
      signedAt: '2027-01-20T09:10:00Z',
    };
    const bad = await one(driver, { type: 'PICKUP_SIGN', payload: { ...base, empreinte: '0'.repeat(64) } });
    expect(bad).toMatchObject({ status: 'ERROR', code: 'EMPREINTE_INVALIDE' });
  });

  it('…puis la vraie signature', async () => {
    const [m] = await missionsOf(commandeId);
    const p = {
      missionId: m!.id,
      blId: uuidv7(),
      articles: [
        { articleId: enleve.etiquete, qr: qrs[0]!, libelle: 'Canapé 3 places', photos: [{ photoId: uuidv7() }] },
        { articleId: enleve.sansEtiquette, libelle: 'Lampadaire', photos: [] },
      ],
      signataire: { nom: 'Camille Martin', qualite: 'Cliente' },
      signatureSvg: SVG,
      signedAt: '2027-01-20T09:10:00Z',
    };
    const data = ok(await one(driver, { type: 'PICKUP_SIGN', payload: { ...p, empreinte: pickupFingerprint(p) } }));
    expect(data.numero).toMatch(/^BL-\d{4}-\d{6}$/);
    const rec = await operator.get('/field/receptions');
    const r = rec.body.find((x: { commandeId: string }) => x.commandeId === commandeId);
    expect(r).toMatchObject({ nbArticles: 2, nbRanges: 0 });
  });

  it('réception : fiche complétée (QR posé à l’enlèvement) et étiquetage du bien sans QR', async () => {
    const photo = uuidv7();
    ok(await one(operator, {
      type: 'ARTICLE_CREATE',
      payload: { articleId: enleve.etiquete, qr: qrs[0]!, libelle: 'Canapé 3 places gris', etat: 'BON', longueurM: 2.2, largeurM: 0.9, photos: [{ photoId: photo }] },
    }));
    // le binaire arrive après les données
    const up = await operator.put(`/field/photos/${photo}`, WEBP, 'image/webp');
    expect(up.status).toBe(200);
    expect((await operator.put(`/field/photos/${uuidv7()}`, WEBP, 'image/webp')).status).toBe(404);
    expect((await operator.put(`/field/photos/${photo}`, Buffer.from('pas une image'), 'image/webp')).status).toBe(422);

    ok(await one(operator, {
      type: 'ARTICLE_CREATE',
      payload: { articleId: enleve.sansEtiquette, qr: qrs[1]!, libelle: 'Lampadaire', etat: 'USE', longueurM: 0.4, largeurM: 0.4, photos: [{ photoId: uuidv7() }] },
    }));
    // §4.1 : un QR déjà attribué à un autre article actif est refusé
    const dup = await one(operator, {
      type: 'ARTICLE_CREATE',
      payload: { articleId: uuidv7(), qr: qrs[1]!, commandeId, libelle: 'Intrus', etat: 'BON', photos: [{ photoId: uuidv7() }] },
    });
    expect(dup).toMatchObject({ status: 'ERROR', code: 'QR_DEJA_UTILISE' });
    // pas de photo, pas d'article (REC-02)
    const noPhoto = await one(operator, { type: 'ARTICLE_CREATE', payload: { articleId: uuidv7(), qr: qrs[3]!, commandeId, libelle: 'X', etat: 'BON', photos: [] } });
    expect(noPhoto).toMatchObject({ status: 'ERROR', code: 'PHOTOS' });
  });

  it('rangement par deux scans, contrôle de zone et de capacité (REC-03)', async () => {
    const quai = await one(operator, { type: 'ARTICLE_STORE', payload: { articleQr: qrs[0]!, locationQr: loc('N-R-QUAI1') } });
    expect(quai).toMatchObject({ status: 'ERROR', code: 'ZONE_NON_STOCKAGE' });
    // une case de rack de 1,2 m² ne contient pas un canapé de 2,2 × 0,9
    const full = await one(operator, { type: 'ARTICLE_STORE', payload: { articleQr: qrs[0]!, locationQr: loc('N-B-04-501') } });
    expect(full).toMatchObject({ status: 'ERROR', code: 'CAPACITE_DEPASSEE' });
    const forced = await one(operator, { type: 'ARTICLE_STORE', payload: { articleQr: qrs[0]!, locationQr: loc('N-B-04-502'), force: true, motif: 'Canapé posé debout' } });
    expect(forced.status).toBe('OK');
    expect((forced as { warnings?: string[] }).warnings?.[0]).toMatch(/Capacité forcée/);
    ok(await one(operator, { type: 'ARTICLE_STORE', payload: { articleQr: qrs[1]!, locationQr: loc('N-B-S06') } }));
  });

  it('palette : création, articles en rafale, rangement de l’UM (REC-04)', async () => {
    const id = uuidv7();
    const { results } = await sync(operator, [
      env({ type: 'UM_CREATE', payload: { umId: uuidv7(), qr: palette!, umType: 'PALETTE' } }),
      env({ type: 'ARTICLE_CREATE', payload: { articleId: id, qr: qrs[2]!, commandeId, libelle: 'Carton vaisselle', etat: 'BON', longueurM: 0.5, largeurM: 0.4, photos: [{ photoId: uuidv7() }] } }),
      env({ type: 'UM_ADD', payload: { umQr: palette!, articleQr: qrs[2]! } }),
      env({ type: 'UM_STORE', payload: { umQr: palette!, locationQr: loc('N-B-S05') } }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK']);
    const art = await operator.get(`/articles/${id}`);
    expect(art.body).toMatchObject({ statut: 'EN_STOCK', localisation: 'Dépôt Nord > Zone B > Sol 5' });
    // ranger l'article seul alors qu'il est sur une UM est refusé
    const alone = await one(operator, { type: 'ARTICLE_STORE', payload: { articleQr: qrs[2]!, locationQr: loc('N-B-S04') } });
    expect(alone).toMatchObject({ status: 'ERROR', code: 'DANS_UM' });
  });

  it('clôture de réception : collecte STOCKEE, articles visibles du client avec photo', async () => {
    const data = ok(await one(operator, { type: 'RECEPTION_CLOSE', payload: { commandeId } }));
    expect(data).toMatchObject({ statut: 'STOCKEE', nbArticles: 3 });
    const b2c = await as(t.data.users.b2c.email);
    const inv = await b2c.get('/articles?limite=200');
    const libelles = inv.body.items.map((a: { libelle: string }) => a.libelle);
    expect(libelles).toEqual(expect.arrayContaining(['Canapé 3 places gris', 'Lampadaire', 'Carton vaisselle']));
    const canape = inv.body.items.find((a: { libelle: string }) => a.libelle === 'Canapé 3 places gris');
    const fiche = await b2c.get(`/articles/${canape.id}`);
    expect(fiche.body.mouvements.map((m: { type: string }) => m.type)).toEqual(['RANGEMENT', 'RECEPTION']);
    expect(fiche.body.photos.length).toBeGreaterThanOrEqual(2); // enlèvement + réception
  });
});

describe('§7.5 synchronisation hors-ligne', () => {
  it('une action renvoyée après coupure n’est pas rejouée (idempotence)', async () => {
    const [qr] = await blankQrs('A', 1);
    const action = env({
      type: 'ARTICLE_CREATE',
      payload: { articleId: uuidv7(), qr: qr!, entrepriseId: t.data.entreprises.particulier, libelle: 'Vélo', etat: 'BON', photos: [{ photoId: uuidv7() }] },
    });
    const first = await sync(operator, [action]);
    const again = await sync(operator, [action]);
    expect(first.results[0]!.status).toBe('OK');
    expect(again.results[0]).toMatchObject({ status: 'OK', replayed: true });
  });

  it('deux déplacements contradictoires : le plus récent l’emporte, l’autre est journalisé et signalé', async () => {
    const id = t.data.articles.particulier[0]!;
    const fiche = await operator.get(`/articles/${id}`);
    const qr = fiche.body.qr_code as string;
    const late = new Date(clock - 3_600_000).toISOString();
    const newer = ok(await one(operator, { type: 'TRANSFER', payload: { qr, locationQr: loc('N-B-04-101') } }));
    expect(newer.applique).toBe(true);
    const { results } = await sync(operator, [env({ type: 'TRANSFER', payload: { qr, locationQr: loc('N-B-04-102') } }, late)]);
    expect(results[0]).toMatchObject({ status: 'OK', data: { applique: false } });
    const after = await operator.get(`/articles/${id}`);
    expect(after.body.localisation).toMatch(/Niveau 1 > Case 1$/);
  });

  it('mesure la dérive d’horloge du terminal', async () => {
    const skewed = new Date(Date.now() - 10 * 60_000).toISOString();
    const res = await sync(operator, [], skewed);
    expect(res.clockSkewMs).toBeGreaterThan(9 * 60_000);
  });

  it('refuse une action hors des droits du rôle', async () => {
    const r = await one(operator, { type: 'DEPART', payload: { missionId: uuidv7() } });
    expect(r).toMatchObject({ status: 'ERROR', code: 'FORBIDDEN' });
  });
});

describe('§4.2 et §4.3 préparation, chargement et livraison signée', () => {
  let orderId: string;
  let prep: string;
  let liv: string;
  let arts: { id: string; qr: string }[];

  it('commande planifiée, missions affectées avec contrôle du véhicule', async () => {
    const admin = await as(t.data.users.b2bAdmin.email);
    const ids = t.data.articles.tilleuls.slice(11, 14); // 3 totems PLV
    const cart = await admin.post('/cart/items', { articleIds: ids, projetId: t.data.projets.tilleuls });
    orderId = cart.body.id;
    const sub = await admin.post(`/orders/${orderId}/submit`, {
      type: 'LIVRAISON',
      adresse: { libelle: '3 avenue du Chantier, Boulogne', lat: 48.8397, lng: 2.2399 },
      contactSite: { nom: 'Chef de chantier', telephone: '0600000000' },
      dateSouhaitee: '2027-01-18',
    });
    expect(sub.body.statut).toBe('SOUMISE');
    await dispatcher.post(`/orders/${orderId}/plan`, { date: '2027-01-18' });
    const ms = await missionsOf(orderId);
    prep = ms.find((m) => m.type === 'PREPARATION')!.id;
    liv = ms.find((m) => m.type === 'LIVRAISON')!.id;
    await dispatcher.post(`/missions/${prep}/assign`, { assigneA: t.data.users.operator.id });
    const a = await dispatcher.post(`/missions/${liv}/assign`, { assigneA: t.data.users.driver.id, vehiculeId: t.data.vehicules.vul12 });
    expect(a.body.warnings).toEqual([]);
    arts = await Promise.all(ids.map(async (id) => ({ id, qr: (await operator.get(`/articles/${id}`)).body.qr_code as string })));
  });

  it('liste de prélèvement triée par chemin, avec vignettes (PRP-01)', async () => {
    const res = await operator.get(`/field/missions/${prep}`);
    expect(res.status).toBe(200);
    const chemins = res.body.lignes.map((l: { chemin: string }) => l.chemin);
    expect(chemins).toEqual([...chemins].sort(new Intl.Collator('fr', { numeric: true }).compare));
    expect(res.body.lignes[0].vignette).toBeTruthy();
    // le chauffeur n'a pas accès à la mission de préparation d'un autre
    expect((await driver.get(`/field/missions/${prep}`)).status).toBe(403);
  });

  it('prélèvement par scan, hors commande bloquant, introuvable déclaré (PRP-02)', async () => {
    const other = (await operator.get(`/articles/${t.data.articles.tilleuls[1]}`)).body.qr_code;
    // envoyés dans le désordre : le serveur rejoue par horodatage terminal
    const a1 = env({ type: 'PICK', payload: { missionId: prep, articleQr: arts[0]!.qr } }, tick());
    const a2 = env({ type: 'PICK', payload: { missionId: prep, articleQr: arts[1]!.qr } }, tick());
    const wrong = env({ type: 'PICK', payload: { missionId: prep, articleQr: other } }, tick());
    const missing = env({ type: 'PICK_MISSING', payload: { missionId: prep, articleId: arts[2]!.id, photoId: uuidv7(), commentaire: 'Emplacement vide' } }, tick());
    const done = env({ type: 'PICK_COMPLETE', payload: { missionId: prep } }, tick());
    const { results } = await sync(operator, [done, missing, wrong, a2, a1]);
    expect(results.map((r) => (r.status === 'OK' ? 'OK' : r.code))).toEqual(['OK', 'OK', 'HORS_COMMANDE', 'OK', 'OK']);
    const order = await dispatcher.get(`/orders/${orderId}`);
    expect(order.body.statut).toBe('PRETE');
    expect(order.body.historique.map((h: { statut: string }) => h.statut)).toEqual(['BROUILLON', 'SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE']);
    // l'article introuvable redevient disponible
    expect((await operator.get(`/articles/${arts[2]!.id}`)).body.statut).toBe('EN_STOCK');
  });

  it('chargement scanné, départ bloqué tant que tout n’est pas chargé (PRP-03)', async () => {
    ok(await one(operator, { type: 'LOAD', payload: { missionId: prep, articleQr: arts[0]!.qr } }));
    expect(await one(driver, { type: 'DEPART', payload: { missionId: liv } })).toMatchObject({ status: 'ERROR', code: 'CHARGEMENT_INCOMPLET' });
    const l2 = ok(await one(operator, { type: 'LOAD', payload: { missionId: prep, articleQr: arts[1]!.qr } }));
    expect(l2).toMatchObject({ faits: 2, total: 2 });
    expect((await operator.get(`/articles/${arts[1]!.id}`)).body.statut).toBe('EN_TRANSIT');
    ok(await one(driver, { type: 'DEPART', payload: { missionId: liv } }));
    expect((await dispatcher.get(`/orders/${orderId}`)).body.statut).toBe('EN_LIVRAISON');
  });

  it('arrivée géolocalisée : alerte si à plus de 500 m', async () => {
    const far = await one(driver, { type: 'ARRIVE', payload: { missionId: liv, gps: { lat: 48.8566, lng: 2.3522, precision: 12 } } });
    expect(far.status).toBe('OK');
    expect((far as { warnings?: string[] }).warnings?.[0]).toMatch(/m de l'adresse/);
  });

  it('BL signé : empreinte contrôlée, réserves, article refusé, commande livrée avec réserves (LIV-03, LIV-04)', async () => {
    const reservePhoto = uuidv7();
    const p = {
      missionId: liv,
      blId: uuidv7(),
      livres: [arts[0]!.id],
      refuses: [arts[1]!.id],
      reserves: [{ articleId: arts[1]!.id, type: 'CASSE' as const, commentaire: 'Socle fendu', photoIds: [reservePhoto] }],
      signataire: { nom: 'Jean Dupont', qualite: 'Chef de chantier' },
      signatureSvg: SVG,
      signedAt: '2027-01-18T09:42:00Z',
      gps: { lat: 48.8397, lng: 2.2399, precision: 8 },
    };
    const tampered = await one(driver, { type: 'BL_SIGN', payload: { ...p, empreinte: blFingerprint({ ...p, livres: [arts[1]!.id], refuses: [arts[0]!.id] }) } });
    expect(tampered).toMatchObject({ status: 'ERROR', code: 'EMPREINTE_INVALIDE' });
    const incomplete = { ...p, refuses: [] as string[], reserves: [] };
    expect(await one(driver, { type: 'BL_SIGN', payload: { ...incomplete, empreinte: blFingerprint(incomplete) } })).toMatchObject({
      status: 'ERROR',
      code: 'ARTICLES_NON_POINTES',
    });

    const signed = ok(await one(driver, { type: 'BL_SIGN', payload: { ...p, empreinte: blFingerprint(p) } }));
    expect(signed).toMatchObject({ statutCommande: 'LIVREE_AVEC_RESERVES', empreinte: blFingerprint(p) });

    const admin = await as(t.data.users.b2bAdmin.email);
    const order = await admin.get(`/orders/${orderId}`);
    expect(order.body.statut).toBe('LIVREE_AVEC_RESERVES');
    expect((await admin.get(`/articles/${arts[0]!.id}`)).body.statut).toBe('RESTITUE');
    // l'article refusé reste en transit jusqu'à son retour au dépôt
    expect((await operator.get(`/articles/${arts[1]!.id}`)).body.statut).toBe('EN_TRANSIT');
    const back = ok(await one(operator, { type: 'RETURN', payload: { articleQr: arts[1]!.qr, motif: 'Refusé à la livraison' } }));
    expect(back.statut).toBe('EN_RECEPTION');
    // la mission terminée n'accepte plus d'action
    expect(await one(driver, { type: 'ARRIVE', payload: { missionId: liv } })).toMatchObject({ status: 'ERROR', code: 'MISSION_TERMINEE' });
  });
});

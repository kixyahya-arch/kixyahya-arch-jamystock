import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type FieldAction, type SyncResult } from '@jamystock/domain';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { TrackingService } from '../src/flux/tracking.service.js';
import { BillingScheduler } from '../src/billing/billing.scheduler.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

/** Lot 5 : tournées (FLX-04), carte des chauffeurs (FLX-05), lien de suivi (SUI-02, LIV-02), modèles d'e-mails (§6.3). */
let t: TestContext;
let owner: pg.Client;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await auth(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const put = async (email: string, path: string, body: unknown = {}) => t.http().put(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);
const del = async (email: string, path: string) => t.http().delete(`/api/v1${path}`).set('Authorization', await auth(email));

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
async function field(email: string, action: FieldAction, at = new Date().toISOString()): Promise<SyncResult> {
  const res = await post(email, '/field/sync', { deviceId: 'terminal-test', deviceTime: new Date().toISOString(), actions: [{ key: uuidv7(), at, action }] });
  expect(res.status).toBe(200);
  return res.body.results[0] as SyncResult;
}
const ok = (r: SyncResult) => {
  if (r.status !== 'OK') throw new Error(`${r.code} : ${r.message}`);
  return r.data as Record<string, unknown>;
};
const u = () => t.data.users;
const DAY = '2026-12-02';
const missionOf = async (commandeId: string) => (await sys<{ id: string }>(`SELECT id FROM mission WHERE commande_id = $1`, [commandeId])).rows[0]!.id;

let stops: { commandeId: string; missionId: string }[] = [];
let tourId: string;
let token: string;

beforeAll(async () => {
  t = await bootstrap();
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  // trois collectes le même jour : Boulogne, Vincennes, Paris 19e (adresses déjà géocodées)
  const addrs = [
    { who: u().b2c.email, adresse: { libelle: '12 rue des Tilleuls, 92100 Boulogne-Billancourt', lat: 48.8396, lng: 2.2399 }, tel: '0611223344' },
    { who: u().b2bAdmin.email, adresse: { libelle: '4 allée des Jardins, 94300 Vincennes', lat: 48.8471, lng: 2.4386 }, tel: '0622334455' },
    { who: u().b2c.email, adresse: { libelle: '27 quai de la Loire, 75019 Paris', lat: 48.8875, lng: 2.3732 }, tel: '0633445566' },
  ];
  for (const a of addrs) {
    const r = await post(a.who, '/collections', { adresse: a.adresse, dateSouhaitee: DAY, description: 'Mobilier', contactSite: { nom: 'Accueil', telephone: a.tel } });
    expect(r.status).toBe(201);
    expect((await post(u().dispatcher.email, `/orders/${r.body.id}/plan`, { date: DAY })).status).toBe(200);
    stops.push({ commandeId: r.body.id, missionId: await missionOf(r.body.id) });
  }
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('tournées (FLX-04)', () => {
  it('le Dispatcher regroupe les arrêts du jour dans une tournée ordonnée', async () => {
    const disp = u().dispatcher.email;
    const before = await get(disp, `/bo/tournees?date=${DAY}`);
    expect(before.status).toBe(200);
    expect(before.body.disponibles.map((s: { missionId: string }) => s.missionId)).toEqual(expect.arrayContaining(stops.map((s) => s.missionId)));

    const [a, b, c] = stops.map((s) => s.missionId) as [string, string, string];
    // un opérateur de quai ne conduit pas ; un arrêt d'un autre jour ne rentre pas
    expect((await post(disp, '/bo/tournees', { date: DAY, chauffeurId: u().operator.id, missionIds: [a] })).status).toBe(422);
    expect((await post(disp, '/bo/tournees', { date: '2026-12-03', chauffeurId: u().driver.id, missionIds: [a] })).body.error.code).toBe('AUTRE_JOUR');
    expect((await post(u().operator.email, '/bo/tournees', { date: DAY, chauffeurId: u().driver.id, missionIds: [a] })).status).toBe(403);

    const r = await post(disp, '/bo/tournees', { date: DAY, chauffeurId: u().driver.id, vehiculeId: t.data.vehicules.vul12, nom: 'Ouest puis Est', missionIds: [b, a] });
    expect(r.status).toBe(201);
    expect(r.body.numero).toMatch(/^TRN-2026-\d{6}$/);
    tourId = r.body.id;
    // un arrêt ne peut pas être dans deux tournées
    expect((await post(disp, '/bo/tournees', { date: DAY, chauffeurId: u().driver.id, missionIds: [a] })).body.error.code).toBe('DEJA_EN_TOURNEE');

    // l'ordre est manuel : Boulogne d'abord, puis Paris 19e, puis Vincennes
    const longWay = (await get(disp, `/bo/tournees?date=${DAY}`)).body.tournees[0].kmEstimes;
    expect((await put(disp, `/bo/tournees/${tourId}`, { chauffeurId: u().driver.id, vehiculeId: t.data.vehicules.vul12, nom: 'Ouest puis Est', missionIds: [a, c, b] })).status).toBe(200);
    const list = await get(disp, `/bo/tournees?date=${DAY}`);
    const tour = list.body.tournees[0];
    expect(tour).toMatchObject({ statut: 'PLANIFIEE', chauffeurId: u().driver.id, vehicule: expect.any(String), faits: 0 });
    expect(tour.arrets.map((s: { missionId: string; ordre: number }) => [s.missionId, s.ordre])).toEqual([[a, 1], [c, 2], [b, 3]]);
    expect(tour.kmEstimes).toBeGreaterThan(10);
    expect(longWay).toBeGreaterThan(0);
    expect(list.body.disponibles.find((s: { missionId: string }) => stops.some((x) => x.missionId === s.missionId))).toBeUndefined();

    const m = await sys<{ statut: string; assigne_a: string; ordre: number; vehicule_id: string }>('SELECT statut, assigne_a, ordre, vehicule_id FROM mission WHERE id = $1', [c]);
    expect(m.rows[0]).toMatchObject({ statut: 'AFFECTEE', assigne_a: u().driver.id, ordre: 2, vehicule_id: t.data.vehicules.vul12 });
    // le terminal du chauffeur reçoit les arrêts dans l'ordre de la tournée
    const boot = await get(u().driver.email, '/field/bootstrap');
    const mine = boot.body.missions.filter((x: { tourneeId: string }) => x.tourneeId === tourId);
    expect(mine.map((x: { id: string }) => x.id)).toEqual([a, c, b]);
    expect(mine[0].tournee).toBe(tour.numero);
  });
});

describe('départ, positions et lien de suivi (LIV-02, FLX-05, SUI-02)', () => {
  it('aucune position n’est acceptée hors mission en cours (RGPD)', async () => {
    const r = await post(u().driver.email, '/field/positions', { positions: [{ lat: 48.93, lng: 2.35, at: new Date().toISOString() }] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ acceptees: 0, actif: false });
    expect((await post(u().operator.email, '/field/positions', { positions: [{ lat: 48.93, lng: 2.35, at: new Date().toISOString() }] })).status).toBe(403);
  });

  it('« En route » : e-mail et SMS avec lien de suivi et heure d’arrivée estimée', async () => {
    const [first] = stops;
    const data = ok(await field(u().driver.email, { type: 'DEPART', payload: { missionId: first!.missionId } }));
    expect(data.suivi).toMatch(/\/#\/suivi\/[0-9a-f-]{36}\.[0-9a-f-]{36}\.\d+\.[\w-]+$/);
    token = String(data.suivi).split('/#/suivi/')[1]!;
    const n = await sys<{ canal: string; variables: Record<string, unknown> }>(
      `SELECT canal, variables FROM notification WHERE modele = 'CHAUFFEUR_EN_ROUTE' AND variables->>'commandeId' = $1 ORDER BY canal`,
      [first!.commandeId],
    );
    expect(n.rows.map((x) => x.canal)).toEqual(['EMAIL', 'SMS']);
    expect(n.rows[0]!.variables).toMatchObject({ suivi: token, type: 'COLLECTE', arretsAvant: 0, chauffeur: expect.any(String) });
    // depuis le dépôt de Saint-Denis jusqu'à Boulogne : une estimation existe dès le départ
    expect(Date.parse(String(n.rows[0]!.variables.eta))).toBeGreaterThan(Date.now());
    expect(n.rows[1]!.variables).toMatchObject({ telephone: '0611223344', url: expect.stringContaining(token) });
    // repartir (renvoi du terminal) ne renvoie pas de message et garde le même lien
    expect(ok(await field(u().driver.email, { type: 'DEPART', payload: { missionId: first!.missionId } })).suivi).toBe(data.suivi);
    expect((await sys(`SELECT 1 FROM notification WHERE modele = 'CHAUFFEUR_EN_ROUTE' AND variables->>'commandeId' = $1`, [first!.commandeId])).rowCount).toBe(2);
  });

  it('le terminal envoie ses positions pendant la mission ; les points trop anciens sont écartés', async () => {
    const now = Date.now();
    const r = await post(u().driver.email, '/field/positions', {
      positions: [
        { lat: 48.9, lng: 2.31, precision: 12, vitesseKmh: 35, at: new Date(now - 60_000).toISOString() },
        { lat: 48.87, lng: 2.28, precision: 9, vitesseKmh: 28, at: new Date(now).toISOString() },
        { lat: 48.0, lng: 2.0, at: new Date(now - 6 * 3600_000).toISOString() },
      ],
    });
    expect(r.body).toEqual({ acceptees: 2, actif: true });
    expect((await post(u().driver.email, '/field/positions', { positions: [{ lat: 91, lng: 2, at: new Date().toISOString() }] })).status).toBe(400);
  });

  it('page de suivi publique : sans connexion, position et heure estimée recalculée', async () => {
    const r = await t.http().get(`/api/v1/public/suivi/${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ etape: 'EN_ROUTE', type: 'COLLECTE', arretsAvant: 0, position: { lat: 48.87, lng: 2.28, fraiche: true }, destination: { lat: 48.8396, lng: 2.2399 }, rafraichirDansS: 60 });
    expect(r.body.missionId).toBeUndefined();
    // depuis la dernière position (4 km environ) : moins d'une demi-heure
    expect(Date.parse(r.body.eta) - Date.now()).toBeLessThan(30 * 60_000);
    expect(Date.parse(r.body.expireLe) - Date.now()).toBeGreaterThan(47 * 3600_000);

    const parts = token.split('.');
    expect((await t.http().get(`/api/v1/public/suivi/${parts.slice(0, 3).join('.')}.${'x'.repeat(43)}`)).status).toBe(404);
    expect((await t.http().get(`/api/v1/public/suivi/${parts[0]}.${stops[1]!.missionId}.${parts[2]}.${parts[3]}`)).status).toBe(404);
    const old = t.app.get(TrackingService).token(t.data.tenantId, stops[0]!.missionId, new Date(Date.now() - 49 * 3600_000));
    const expired = await t.http().get(`/api/v1/public/suivi/${old}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('LIEN_EXPIRE');
  });

  it('un arrêt plus loin dans la tournée compte les arrêts restants avant lui', async () => {
    const third = stops[1]!; // Vincennes, 3e arrêt
    const data = ok(await field(u().driver.email, { type: 'DEPART', payload: { missionId: third.missionId } }));
    const tok = String(data.suivi).split('/#/suivi/')[1]!;
    const s = (await t.http().get(`/api/v1/public/suivi/${tok}`)).body;
    expect(s.arretsAvant).toBe(2); // Boulogne pas encore atteint, Paris 19e pas encore fait
    ok(await field(u().driver.email, { type: 'ARRIVE', payload: { missionId: stops[0]!.missionId, gps: { lat: 48.8396, lng: 2.2399 } } }));
    expect((await t.http().get(`/api/v1/public/suivi/${token}`)).body).toMatchObject({ etape: 'ARRIVE', position: null, eta: null });
    const after = (await t.http().get(`/api/v1/public/suivi/${tok}`)).body;
    expect(after.arretsAvant).toBe(1);
    // les positions vont au dernier arrêt parti, pas encore atteint
    expect((await post(u().driver.email, '/field/positions', { positions: [{ lat: 48.84, lng: 2.3, at: new Date().toISOString() }] })).body.actif).toBe(true);
  });

  it('carte des chauffeurs : position et mission en cours, réservée au planning', async () => {
    const r = await get(u().dispatcher.email, `/bo/flux/carte?date=${DAY}`);
    expect(r.status).toBe(200);
    const d = r.body.chauffeurs.find((c: { id: string }) => c.id === u().driver.id);
    expect(d.position).toMatchObject({ lat: 48.84, lng: 2.3, fraiche: true });
    expect(d.enCours).toMatchObject({ missionId: stops[1]!.missionId, etape: 'EN_ROUTE', eta: expect.any(String) });
    expect(d).toMatchObject({ total: 3, faits: 0, tournee: expect.stringMatching(/^TRN-/) });
    expect(r.body.depots[0]).toMatchObject({ lat: expect.any(Number) });
    expect((await get(u().driver.email, '/bo/flux/carte')).status).toBe(403);
  });

  it('le client retrouve le lien de suivi sur sa commande', async () => {
    const r = await get(u().b2c.email, `/orders/${stops[0]!.commandeId}`);
    expect(r.body.suivi).toMatchObject({ jeton: token, expireLe: expect.any(String) });
    expect((await get(u().b2c.email, `/orders/${stops[2]!.commandeId}`)).body.suivi).toBeNull();
  });

  it('une tournée commencée ne s’annule pas ; ses arrêts commencés ne la quittent pas', async () => {
    const disp = u().dispatcher.email;
    expect((await post(disp, `/bo/tournees/${tourId}/annuler`)).body.error.code).toBe('TOURNEE_COMMENCEE');
    const r = await put(disp, `/bo/tournees/${tourId}`, { chauffeurId: u().driver.id, missionIds: [stops[0]!.missionId, stops[2]!.missionId] });
    expect(r.body.error.code).toBe('ARRET_COMMENCE');
    expect((await get(disp, `/bo/tournees?date=${DAY}`)).body.tournees[0].statut).toBe('EN_COURS');
  });

  it('les positions de plus de 30 jours sont purgées par la tâche quotidienne', async () => {
    await sys(
      `INSERT INTO position_chauffeur (id, tenant_id, utilisateur_id, mission_id, lat, lng, horodatage) VALUES ($1, $2, $3, $4, 48.9, 2.3, now() - interval '31 days')`,
      [uuidv7(), t.data.tenantId, u().driver.id, stops[0]!.missionId],
    );
    const r = await t.app.get(BillingScheduler).runFor(t.data.tenantId, new Date());
    expect(r.positionsPurgees).toBe(1);
    expect((await sys(`SELECT 1 FROM position_chauffeur`)).rowCount).toBeGreaterThan(0);
  });
});

describe('modèles d’e-mails modifiables (§6.3)', () => {
  const admin = () => u().superAdmin.email;
  it('liste, texte d’origine avec repères, aperçu', async () => {
    const list = await get(admin(), '/bo/email-templates');
    expect(list.status).toBe(200);
    expect(list.body.find((x: { modele: string }) => x.modele === 'CHAUFFEUR_EN_ROUTE')).toMatchObject({ personnalise: false });
    const one = await get(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE');
    expect(one.body.reperes).toEqual(expect.arrayContaining(['numero', 'chauffeur', 'eta', 'arretsAvant']));
    expect(one.body.defaut.sujet).toBe('Votre livraison est en route : {{numero}}');
    expect(one.body.defaut.corps).toContain('{{chauffeur}}, votre chauffeur,');
    expect(one.body.apercu.text).toContain('Arrivée estimée vers 14 h 20');
    expect((await get(u().dispatcher.email, '/bo/email-templates')).status).toBe(403);
    expect((await get(admin(), '/bo/email-templates/INCONNU')).status).toBe(404);
  });

  it('un texte personnalisé est utilisé à l’envoi ; un repère inconnu est refusé', async () => {
    const bad = await put(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE', { sujet: 'En route {{numerot}}', corps: 'Bonjour' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('REPERE_INCONNU');
    const body = { sujet: 'JAMYSTOCK arrive : {{numero}}', corps: '{{chauffeur}} arrive vers {{eta}}.\n\nMerci de prévenir l’accueil.', bouton: 'Voir le camion' };
    const prev = await post(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE/apercu', body);
    expect(prev.body).toMatchObject({ subject: 'JAMYSTOCK arrive : CMD-2026-000042' });
    expect(prev.body.text).toContain('Karim arrive vers 14 h 20.');
    expect(prev.body.text).toContain('Voir le camion : ');
    expect((await put(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE', body)).status).toBe(200);

    await t.app.get(NotificationsService).flush(t.data.tenantId);
    const sent = await sys<{ objet: string; statut: string }>(
      `SELECT objet, statut FROM notification WHERE modele = 'CHAUFFEUR_EN_ROUTE' AND canal = 'EMAIL' AND variables->>'commandeId' = $1`,
      [stops[0]!.commandeId],
    );
    expect(sent.rows[0]!.objet).toMatch(/^JAMYSTOCK arrive : CMD-/);
    // l'e-mail renvoie vers la page de suivi
    const id = (await sys<{ id: string }>(`SELECT id FROM notification WHERE modele = 'CHAUFFEUR_EN_ROUTE' AND canal = 'EMAIL' AND variables->>'commandeId' = $1`, [stops[0]!.commandeId])).rows[0]!.id;
    expect((await get(admin(), `/bo/emails/${id}`)).body.text).toContain(`#/suivi/${token}`);

    expect((await get(admin(), '/bo/email-templates')).body.find((x: { modele: string }) => x.modele === 'CHAUFFEUR_EN_ROUTE')).toMatchObject({ personnalise: true, modifiePar: expect.any(String) });
    expect((await del(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE')).status).toBe(200);
    expect((await get(admin(), '/bo/email-templates/CHAUFFEUR_EN_ROUTE')).body.actuel).toBeNull();
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

/** ADM-03 : utilisateurs clients, invitations, désactivation immédiate ; §6.3 : file des e-mails et préférences. */
let t: TestContext;
let owner: pg.Client;
let mails: NotificationsService;
const as = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await as(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);
const put = async (email: string, path: string, body: unknown) => t.http().put(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);

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

const tokenOf = (lien: string) => lien.split('#/invitation/')[1]!;
let admin: string;
let newUserId: string;
let lien: string;

beforeAll(async () => {
  t = await bootstrap();
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  mails = t.app.get(NotificationsService);
  admin = t.data.users.b2bAdmin.email;
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('utilisateurs de l’entreprise (ADM-03)', () => {
  it('réservé à l’administrateur client', async () => {
    expect((await get(t.data.users.b2bUser.email, '/me/users')).status).toBe(403);
    expect((await get(t.data.users.b2c.email, '/me/users')).status).toBe(403);
    const r = await get(admin, '/me/users');
    expect(r.status).toBe(200);
    expect(r.body.items.map((u: { email: string }) => u.email)).toEqual(expect.arrayContaining(['dsg@horizon.test', 'chef.projet@horizon.test']));
    expect(r.body.items.some((u: { email: string }) => u.email === 'admin@batir.test')).toBe(false);
    expect(r.body.projets).toHaveLength(2);
  });

  it('invite un utilisateur sur un projet et met l’e-mail en file', async () => {
    expect((await post(admin, '/me/users', { email: 'chef.projet@horizon.test', nom: 'Doublon', role: 'B2B_USER' })).status).toBe(409);
    expect((await post(admin, '/me/users', { email: 'x@horizon.test', nom: 'Projet étranger', role: 'B2B_USER', projets: [t.data.projets.autre] })).status).toBe(422);
    const r = await post(admin, '/me/users', { email: 'Nouvelle.Recrue@Horizon.test', nom: 'Nouvelle recrue', role: 'B2B_USER', projets: [t.data.projets.jardins] });
    expect(r.status).toBe(201);
    newUserId = r.body.id;
    lien = r.body.lien; // aucun service d'e-mail configuré : le lien est rendu à l'administrateur
    expect(lien).toMatch(/#\/invitation\/[\w-]{40,}$/);
    const u = await sys<{ statut: string; email: string; mot_de_passe_hash: string | null }>('SELECT statut, email, mot_de_passe_hash FROM utilisateur WHERE id = $1', [newUserId]);
    expect(u.rows[0]).toEqual({ statut: 'INVITE', email: 'nouvelle.recrue@horizon.test', mot_de_passe_hash: null });
    // seul le hash du jeton est en base
    const inv = await sys<{ token_hash: string; jours: number }>(`SELECT token_hash, round(extract(epoch FROM expire_le - created_at) / 86400)::int AS jours FROM invitation WHERE utilisateur_id = $1`, [newUserId]);
    expect(inv.rows[0]!.jours).toBe(7);
    expect(inv.rows[0]!.token_hash).not.toContain(tokenOf(lien));

    const sent = await mails.flush(t.data.tenantId);
    expect(sent.envoyes).toBeGreaterThanOrEqual(1);
    const n = await sys<{ statut: string; objet: string; fournisseur: string; destinataire_adresse: string }>(
      `SELECT statut, objet, fournisseur, destinataire_adresse FROM notification WHERE modele = 'INVITATION' AND destinataire_id = $1`,
      [newUserId],
    );
    expect(n.rows[0]).toMatchObject({ statut: 'ENVOYEE', fournisseur: 'JOURNAL', destinataire_adresse: 'nouvelle.recrue@horizon.test' });
    expect(n.rows[0]!.objet).toContain('vous invite');
  });

  it('accepte l’invitation une seule fois, avec un mot de passe solide', async () => {
    const token = tokenOf(lien);
    const info = await t.http().get(`/api/v1/auth/invitation/${token}`);
    expect(info.body).toMatchObject({ email: 'nouvelle.recrue@horizon.test', entreprise: 'Promotion Horizon SAS' });
    expect((await t.http().get('/api/v1/auth/invitation/inconnu-inconnu-inconnu-inconnu')).status).toBe(410);
    expect((await t.http().post('/api/v1/auth/invitation/accept').send({ token, password: 'court1' })).status).toBe(400);
    expect((await t.http().post('/api/v1/auth/invitation/accept').send({ token, password: 'sanschiffreaucun' })).status).toBe(400);
    const ok = await t.http().post('/api/v1/auth/invitation/accept').send({ token, password: 'Bienvenue2026' });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    const again = await t.http().post('/api/v1/auth/invitation/accept').send({ token, password: 'Bienvenue2026' });
    expect(again.status).toBe(410);
    // projet par projet : la recrue ne voit que le bureau témoin
    const ctx = await t.http().get('/api/v1/me/context').set('Authorization', `Bearer ${ok.body.accessToken}`);
    expect(ctx.body.projets.map((p: { nom: string }) => p.nom)).toEqual(['Bureau témoin Les Jardins']);
    const login = await t.http().post('/api/v1/auth/login').send({ email: 'nouvelle.recrue@horizon.test', password: 'Bienvenue2026' });
    expect(login.status).toBe(200);
  });

  it('un lien expiré ou remplacé ne fonctionne plus', async () => {
    const r = await post(admin, '/me/users', { email: 'retard@horizon.test', nom: 'En retard', role: 'B2B_USER' });
    const first = tokenOf(r.body.lien);
    const second = tokenOf((await post(admin, `/me/users/${r.body.id}/invite`)).body.lien);
    expect((await t.http().get(`/api/v1/auth/invitation/${first}`)).status).toBe(410);
    await sys('UPDATE invitation SET expire_le = now() - interval \'1 minute\' WHERE utilisateur_id = $1 AND revoquee_le IS NULL', [r.body.id]);
    const exp = await t.http().get(`/api/v1/auth/invitation/${second}`);
    expect(exp.status).toBe(410);
    expect(exp.body.error.code).toBe('INVITATION_EXPIREE');
    const list = (await get(admin, '/me/users')).body.items.find((u: { id: string }) => u.id === r.body.id);
    expect(list.invitation.expiree).toBe(true);
  });

  it('modifie le rôle et les projets, garde au moins un administrateur', async () => {
    expect((await put(admin, `/me/users/${newUserId}`, { projets: [t.data.projets.jardins, t.data.projets.tilleuls], peutCommanderSeul: false })).status).toBe(200);
    const rows = await sys<{ n: number }>('SELECT count(*)::int AS n FROM acces_projet WHERE utilisateur_id = $1', [newUserId]);
    expect(rows.rows[0]!.n).toBe(2);
    expect((await put(admin, `/me/users/${t.data.users.b2bAdmin.id}`, { role: 'B2B_USER' })).status).toBe(409);
    expect((await put(t.data.users.otherB2bAdmin.email, `/me/users/${newUserId}`, { nom: 'Pirate' })).status).toBe(404);
    const audit = await sys<{ action: string }>(`SELECT action FROM journal_audit WHERE objet_id = $1 ORDER BY horodatage`, [newUserId], 'SUPER_ADMIN');
    expect(audit.rows.map((a) => a.action)).toEqual(expect.arrayContaining(['UTILISATEUR_INVITE', 'INVITATION_ACCEPTEE', 'UTILISATEUR_MODIFIE']));
  });

  it('la désactivation coupe immédiatement la session', async () => {
    const login = await t.http().post('/api/v1/auth/login').send({ email: 'nouvelle.recrue@horizon.test', password: 'Bienvenue2026' });
    const bearer = `Bearer ${login.body.accessToken}`;
    expect((await t.http().get('/api/v1/me/context').set('Authorization', bearer)).status).toBe(200);
    expect((await post(admin, `/me/users/${t.data.users.b2bAdmin.id}/deactivate`)).status).toBe(409);
    expect((await post(admin, `/me/users/${newUserId}/deactivate`)).status).toBe(200);
    expect((await t.http().get('/api/v1/me/context').set('Authorization', bearer)).status).toBe(401);
    expect((await t.http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken })).status).toBe(401);
    expect((await t.http().post('/api/v1/auth/login').send({ email: 'nouvelle.recrue@horizon.test', password: 'Bienvenue2026' })).status).toBe(401);
    // réactivation : le mot de passe existant fonctionne de nouveau
    expect((await post(admin, `/me/users/${newUserId}/reactivate`)).body.statut).toBe('ACTIF');
    expect((await t.http().post('/api/v1/auth/login').send({ email: 'nouvelle.recrue@horizon.test', password: 'Bienvenue2026' })).status).toBe(200);
  });
});

describe('e-mails et préférences (§6.3)', () => {
  it('chacun coupe les e-mails non obligatoires', async () => {
    const u = t.data.users.b2bUser;
    const prefs = await get(u.email, '/me/preferences');
    expect(prefs.body.items.find((p: { modele: string }) => p.modele === 'COMMANDE_SOUMISE').email).toBe(true);
    expect(prefs.body.items.some((p: { modele: string }) => p.modele === 'VALIDATION_REQUISE')).toBe(false);
    expect((await put(u.email, '/me/preferences', { COMMANDE_SOUMISE: false, FACTURE_EMISE: false })).status).toBe(200);
    const saved = await sys<{ p: Record<string, boolean> }>('SELECT preferences_notification AS p FROM utilisateur WHERE id = $1', [u.id]);
    expect(saved.rows[0]!.p).toEqual({ COMMANDE_SOUMISE: false }); // un message transactionnel ne se coupe pas

    await sys(
      `INSERT INTO notification (tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,'EMAIL','COMMANDE_SOUMISE','{"numero":"CMD-1"}'), ($1,$2,'EMAIL','LIVRAISON_EFFECTUEE','{"numero":"CMD-1"}')`,
      [t.data.tenantId, u.id],
    );
    await mails.flush(t.data.tenantId);
    const n = await sys<{ modele: string; statut: string }>(`SELECT modele, statut FROM notification WHERE destinataire_id = $1 AND variables->>'numero' = 'CMD-1' ORDER BY modele`, [u.id]);
    expect(n.rows).toEqual([
      { modele: 'COMMANDE_SOUMISE', statut: 'IGNOREE' },
      { modele: 'LIVRAISON_EFFECTUEE', statut: 'ENVOYEE' },
    ]);
  });

  it('le Back-Office suit les e-mails et en affiche l’aperçu', async () => {
    const sa = t.data.users.superAdmin.email;
    expect((await get(admin, '/bo/emails')).status).toBe(403);
    const list = await get(sa, '/bo/emails?statut=ENVOYEE');
    expect(list.body.fournisseur).toBe('JOURNAL');
    const inv = list.body.items.find((m: { modele: string }) => m.modele === 'INVITATION');
    const p = await get(sa, `/bo/emails/${inv.id}`);
    expect(p.body.subject).toContain('vous invite');
    expect(p.body.html).toContain('Activer mon accès');
    expect(p.body.text).toContain('#/invitation/');
  });

  it('l’ouverture d’un compte client invite son contact', async () => {
    const sa = t.data.users.superAdmin.email;
    const r = await post(sa, '/bo/clients', { type: 'B2C', nom: 'Jean Dupont', contact: { nom: 'Jean Dupont', email: 'jean.dupont@exemple.test' } });
    expect(r.status).toBe(201);
    expect(r.body.invitation.lien).toContain('#/invitation/');
    const info = await t.http().get(`/api/v1/auth/invitation/${tokenOf(r.body.invitation.lien)}`);
    expect(info.body).toMatchObject({ email: 'jean.dupont@exemple.test', entreprise: 'Jean Dupont' });
  });
});

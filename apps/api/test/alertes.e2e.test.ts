import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import sharp from 'sharp';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { AlertsService } from '../src/alerts/alerts.service.js';

/** §6.2 alertes de forfait (RG-AL-01 à 05), demande de forfait supérieur, photos et prévision de la collecte (CMD-06). */
let t: TestContext;
const auth = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await auth(email));
const post = async (email: string, path: string, body: unknown) => t.http().post(`/api/v1${path}`).set('Authorization', await auth(email)).send(body as object);

async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
    const r = await c.query<T>(text, params);
    await c.query('COMMIT');
    return r.rows;
  } finally {
    await c.end();
  }
}
const notifs = (modele: string) => sql<{ destinataire_id: string; variables: Record<string, unknown> }>('SELECT destinataire_id, variables FROM notification WHERE modele = $1 ORDER BY created_at', [modele]);

beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('prévision de surface avant une collecte (RG-AL-03)', () => {
  it('l’administrateur voit les chiffres : surface prévue face aux m² inclus', async () => {
    const small = await get(t.data.users.b2bAdmin.email, '/me/collecte/prevision?m2=1');
    expect(small.status).toBe(200);
    expect(small.body).toMatchObject({ forfait: true, depasse: false, m2Inclus: 120 });
    const big = await get(t.data.users.b2bAdmin.email, '/me/collecte/prevision?volume=240');
    expect(big.body).toMatchObject({ forfait: true, depasse: true, niveau: 'DEPASSEMENT', m2Ajoutes: 200 });
    expect(big.body.m2Depassement).toBeGreaterThan(80);
  });

  it('un utilisateur de projet n’a que la conclusion, sans les chiffres du compte', async () => {
    const r = await get(t.data.users.b2bUser.email, '/me/collecte/prevision?m2=500');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ forfait: true, depasse: true, niveau: 'DEPASSEMENT' });
  });

  it('sa demande de collecte qui fera dépasser le forfait prévient ses administrateurs', async () => {
    const r = await post(t.data.users.b2bUser.email, '/collections', {
      projetId: t.data.projets.tilleuls,
      adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' },
      dateSouhaitee: '2027-01-20',
      description: '40 bureaux',
      volumeEstimeM3: 240,
      lignes: [{ description: 'Bureau', quantite: 40 }],
    });
    expect(r.status).toBe(201);
    const sent = await notifs('ALERTE_PREVISION');
    expect(sent.map((n) => n.destinataire_id)).toContain(t.data.users.b2bAdmin.id);
    expect(sent[0]!.variables).toMatchObject({ numero: r.body.numero, commandeId: r.body.id, m2Inclus: 120 });
    expect(await sql(`SELECT 1 FROM alerte_envoyee WHERE regle = 'RG-AL-03' AND entreprise_id = $1`, [t.data.entreprises.promoteur])).toHaveLength(1);
    // la collecte en cours compte désormais dans la prévision suivante
    const next = await get(t.data.users.b2bAdmin.email, '/me/collecte/prevision?m2=0');
    expect(next.body.m2EnCours).toBeGreaterThanOrEqual(200);
    await post(t.data.users.b2bAdmin.email, `/orders/${r.body.id}/cancel`, { motif: 'Essai' });
  });
});

describe('photos d’une demande de collecte (CMD-06)', () => {
  let id: string;
  const jpeg = () => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toBuffer();
  const put = async (email: string, orderId: string, body: Buffer, type = 'image/jpeg') =>
    t.http().put(`/api/v1/collections/${orderId}/photos/${crypto.randomUUID()}`).set('Authorization', await auth(email)).set('Content-Type', type).send(body);

  it('le demandeur joint des photos à sa demande, et les retrouve sur la demande', async () => {
    const r = await post(t.data.users.b2c.email, '/collections', { adresse: { libelle: '8 rue des Lilas, 75020 Paris' }, dateSouhaitee: '2027-01-22', description: 'Un canapé' });
    id = r.body.id;
    expect((await put(t.data.users.b2c.email, id, await jpeg())).status).toBe(200);
    expect((await put(t.data.users.b2c.email, id, await jpeg())).status).toBe(200);
    const list = await get(t.data.users.b2c.email, `/collections/${id}/photos`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).toMatchObject({ vignette: expect.stringContaining('/t?'), originale: expect.stringContaining('/o?') });
    expect((await t.http().get(list.body[0].vignette)).status).toBe(200);
    const detail = await get(t.data.users.b2c.email, `/orders/${id}`);
    expect(detail.body).toMatchObject({ descriptionCollecte: 'Un canapé', demandeurId: t.data.users.b2c.id });
  });

  it('le dispatch les voit sur la fiche de la demande', async () => {
    const r = await get(t.data.users.dispatcher.email, `/bo/orders/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.photosCollecte).toHaveLength(2);
  });

  it('un autre client ne peut ni en ajouter ni les voir ; un faux JPEG est refusé', async () => {
    expect((await put(t.data.users.otherB2bAdmin.email, id, await jpeg())).status).toBe(404);
    expect((await get(t.data.users.otherB2bAdmin.email, `/collections/${id}/photos`)).status).toBe(404);
    expect((await put(t.data.users.b2c.email, id, Buffer.from('pas une image'))).status).toBe(422);
    expect((await put(t.data.users.b2c.email, id, await jpeg(), 'image/gif')).status).toBe(422);
  });

  it('plus d’ajout une fois la demande annulée', async () => {
    await post(t.data.users.b2c.email, `/orders/${id}/cancel`, {});
    expect((await put(t.data.users.b2c.email, id, await jpeg())).status).toBe(409);
  });
});

describe('alertes quotidiennes de forfait (RG-AL-01, 02, 04)', () => {
  const at = new Date('2026-12-10T08:00:00Z');

  it('3 jours au-dessus du forfait : e-mail de dépassement au client (avec le coût) et au Super Admin, une fois', async () => {
    for (const d of ['2026-12-07', '2026-12-08', '2026-12-09']) {
      await sql(`INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, date, m2_occupes, nb_articles) VALUES (gen_random_uuid(), $1, $2, $3, 131.2, 50)`, [
        t.data.tenantId,
        t.data.entreprises.promoteur,
        d,
      ]);
    }
    const alerts = t.app.get(AlertsService);
    expect(await alerts.run(t.data.tenantId, new Date('2026-12-10T05:00:00Z'))).toBeNull(); // avant 7 h à Paris
    const r = await alerts.run(t.data.tenantId, at);
    expect(r?.alertes).toBeGreaterThanOrEqual(1);
    const sent = await notifs('ALERTE_DEPASSEMENT');
    const ids = sent.map((n) => n.destinataire_id);
    expect(ids).toContain(t.data.users.b2bAdmin.id);
    expect(ids).toContain(t.data.users.superAdmin.id);
    expect(ids).not.toContain(t.data.users.b2bUser.id);
    // 11,5 m² arrondis au demi-m² supérieur × 17 € HT
    expect(sent.find((n) => n.destinataire_id === t.data.users.b2bAdmin.id)!.variables).toMatchObject({ m2Depassement: 11.2, coutMensuelCents: 11.5 * 1700, copieExploitant: false });
    // une seule passe par jour, et pas de nouvel envoi avant 7 jours
    expect(await alerts.run(t.data.tenantId, new Date('2026-12-10T15:00:00Z'))).toBeNull();
    await sql(`INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, date, m2_occupes, nb_articles) VALUES (gen_random_uuid(), $1, $2, '2026-12-10', 131.2, 50)`, [
      t.data.tenantId,
      t.data.entreprises.promoteur,
    ]);
    await alerts.run(t.data.tenantId, new Date('2026-12-11T08:00:00Z'));
    expect((await notifs('ALERTE_DEPASSEMENT')).length).toBe(sent.length);
  });

  it('l’e-mail se rend avec le coût du dépassement', async () => {
    const { renderEmail } = await import('../src/notifications/templates.js');
    const m = renderEmail('ALERTE_DEPASSEMENT', { m2Occupes: 131.2, m2Inclus: 120, m2Depassement: 11.2, coutMensuelCents: 19550 }, { publicUrl: 'https://x', destinataire: 'Sophie' })!;
    expect(m.subject).toBe('Votre forfait est dépassé');
    expect(m.text).toContain('195,50');
    expect(m.text).toContain('forfait supérieur');
  });
});

describe('biens dormants (RG-AL-05)', () => {
  it('un bien sans mouvement depuis plus d’un an apparaît dans le rapport, avec sa vignette', async () => {
    const id = t.data.articles.tilleuls[0]!;
    await sql(`UPDATE article SET dernier_mouvement_le = '2025-06-01', date_entree = '2025-05-20' WHERE id = $1`, [id]);
    const r = await get(t.data.users.b2bAdmin.email, '/me/dormants');
    expect(r.status).toBe(200);
    expect(r.body.depuisMois).toBe(12);
    const item = r.body.items.find((a: { id: string }) => a.id === id);
    expect(item).toMatchObject({ projetId: t.data.projets.tilleuls, vignette: expect.stringContaining('/t?') });
    expect(r.body.total).toBe(r.body.items.length);
    // un autre client ne le voit pas
    const other = await get(t.data.users.otherB2bAdmin.email, '/me/dormants');
    expect(other.body.items.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('le rapport trimestriel part aux administrateurs au début du trimestre, une fois', async () => {
    const alerts = t.app.get(AlertsService);
    await alerts.run(t.data.tenantId, new Date('2027-01-05T08:00:00Z'));
    const sent = await notifs('RAPPORT_DORMANTS');
    expect(sent.map((n) => n.destinataire_id)).toContain(t.data.users.b2bAdmin.id);
    expect(sent[0]!.variables).toMatchObject({ trimestre: '2027-T1' });
    await alerts.run(t.data.tenantId, new Date('2027-01-06T08:00:00Z'));
    expect((await notifs('RAPPORT_DORMANTS')).length).toBe(sent.length);
    // en cours de trimestre, pas de rapport (pas de rafale juste après une reprise de données)
    await alerts.run(t.data.tenantId, new Date('2027-02-20T08:00:00Z'));
    expect((await notifs('RAPPORT_DORMANTS')).length).toBe(sent.length);
  });
});

describe('demande de forfait supérieur', () => {
  it('l’administrateur du compte la transmet à l’exploitant', async () => {
    const r = await post(t.data.users.b2bAdmin.email, '/me/forfait/demande', { m2Souhaites: 160, message: 'Arrivée du showroom en mars' });
    expect(r.status).toBe(200);
    const sent = await notifs('DEMANDE_FORFAIT');
    expect(sent.map((n) => n.destinataire_id)).toContain(t.data.users.superAdmin.id);
    expect(sent[0]!.variables).toMatchObject({ m2Souhaites: 160, entreprise: 'Promotion Horizon SAS' });
  });

  it('un utilisateur de projet ne peut pas', async () => {
    expect((await post(t.data.users.b2bUser.email, '/me/forfait/demande', {})).status).toBe(403);
  });
});

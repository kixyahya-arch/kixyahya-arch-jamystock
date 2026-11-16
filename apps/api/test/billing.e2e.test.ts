import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { BillingScheduler } from '../src/billing/billing.scheduler.js';

/** Facturation : instantanés (FAC-02), brouillons et émission (FAC-03), avoirs (FAC-04), tarifs (FAC-01), documents client (SUI-03). */
let t: TestContext;
const as = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) => t.http().get(`/api/v1${path}`).set('Authorization', await as(email));
const post = async (email: string, path: string, body: unknown = {}) => t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);
const put = async (email: string, path: string, body: unknown) => t.http().put(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object);
const binary = (res: { body: unknown }) => res.body as Buffer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const r = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

const getBin = async (email: string, path: string) =>
  t.http().get(`/api/v1${path}`).set('Authorization', await as(email)).buffer(true).parse(pdfParser);
const postBin = async (email: string, path: string, body: unknown) =>
  t.http().post(`/api/v1${path}`).set('Authorization', await as(email)).send(body as object).buffer(true).parse(pdfParser);

let admin: string;
let horizon: string;
let owner: pg.Client;
let invoiceId: string;

/** Instantanés posés directement (comme le ferait la tâche de 23 h 59). */
async function snapshots(entrepriseId: string, from: string, to: string, m2: number) {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
  await owner.query(
    `INSERT INTO instantane_occupation (tenant_id, entreprise_id, date, m2_occupes, nb_articles)
     SELECT $1, $2, d::date, $5, 10 FROM generate_series($3::date, $4::date, interval '1 day') d`,
    [t.data.tenantId, entrepriseId, from, to, m2],
  );
  await owner.query('COMMIT');
}

async function sys<T>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
  try {
    const r = await owner.query<T & pg.QueryResultRow>(sql, params);
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
  horizon = t.data.entreprises.promoteur;
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  // trois livraisons en août : deux incluses au forfait Horizon, la troisième facturée
  await sys(
    `INSERT INTO prestation_a_facturer (tenant_id, entreprise_id, code, libelle, unite, prix_unitaire_ht_cents, date_prestation)
     VALUES ($1,$2,'LIVRAISON_ZONE1','Livraison Île-de-France','livraison',15000,'2026-08-04'),
            ($1,$2,'LIVRAISON_ZONE1','Livraison Île-de-France','livraison',15000,'2026-08-12'),
            ($1,$2,'LIVRAISON_ZONE1','Livraison Île-de-France','livraison',15000,'2026-08-26')`,
    [t.data.tenantId, horizon],
  );
});
afterAll(async () => {
  await owner.end();
  await t.app.close();
});

describe('accès', () => {
  it('la facturation est réservée au Super Admin', async () => {
    expect((await get(t.data.users.dispatcher.email, '/bo/billing/invoices')).status).toBe(403);
    expect((await get(t.data.users.b2bAdmin.email, '/bo/billing/invoices')).status).toBe(403);
    expect((await get(admin, '/bo/billing/invoices')).status).toBe(200);
  });
});

describe('brouillon mensuel (FAC-03, RG-M2-05, RG-M2-06)', () => {
  it('reproduit l’exemple du cahier des charges : 131,2 m² → 131,5 m², 1 995,50 € HT plus la livraison hors forfait', async () => {
    await snapshots(horizon, '2026-08-01', '2026-08-31', 131.2);
    const res = await post(admin, '/bo/billing/drafts', { mois: '2026-08', entrepriseId: horizon });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ crees: 1, recalcules: 0 });
    invoiceId = res.body.factures[0];
    const f = (await get(admin, `/bo/billing/invoices/${invoiceId}`)).body;
    expect(f).toMatchObject({ statut: 'BROUILLON', m2Factures: 131.5, periodeDebut: '2026-08-01', periodeFin: '2026-08-31' });
    expect(f.lignes.map((l: { type: string; totalHtCents: number }) => [l.type, l.totalHtCents])).toEqual([
      ['ABONNEMENT', 180000],
      ['DEPASSEMENT_M2', 19550],
      ['PRESTATION', 15000],
    ]);
    expect(f.totalHtCents).toBe(214550);
    expect(f.tvaCents).toBe(42910);
    expect(f.jours).toHaveLength(31);
  });

  it('un recalcul met à jour le brouillon sans le dupliquer', async () => {
    const res = await post(admin, '/bo/billing/drafts', { mois: '2026-08', entrepriseId: horizon });
    expect(res.body).toMatchObject({ crees: 0, recalcules: 1 });
    expect((await get(admin, `/bo/billing/invoices/${invoiceId}`)).body.lignes).toHaveLength(3);
  });

  it('refuse un mois à venir', async () => {
    expect((await post(admin, '/bo/billing/drafts', { mois: '2099-01' })).status).toBe(422);
  });

  it('une ligne ajoutée à la main exige un motif et met à jour les totaux', async () => {
    const line = { libelle: 'Photo à la demande', quantite: 2, unite: 'photo', prixUnitaireHtCents: 1500, tauxTva: 20 };
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/lines`, line)).status).toBe(400);
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/lines`, { ...line, motif: 'Demande du client du 12 août' })).status).toBe(201);
    const f = (await get(admin, `/bo/billing/invoices/${invoiceId}`)).body;
    expect(f.totalHtCents).toBe(217550);
    const added = f.lignes.find((l: { libelle: string }) => l.libelle === 'Photo à la demande');
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/lines/${added.id}/remove`, { motif: 'Finalement offerte' })).status).toBe(201);
    expect((await get(admin, `/bo/billing/invoices/${invoiceId}`)).body.totalHtCents).toBe(214550);
  });
});

describe('émission (FAC-03)', () => {
  it('une facture bloquée ne part pas', async () => {
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/block`, { bloquee: true })).status).toBe(422);
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/block`, { bloquee: true, motif: 'Surface à vérifier' })).status).toBe(201);
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/issue`)).status).toBe(409);
    await post(admin, `/bo/billing/invoices/${invoiceId}/block`, { bloquee: false });
  });

  it('numérote sans trou, fige le PDF et son empreinte', async () => {
    const res = await post(admin, `/bo/billing/invoices/${invoiceId}/issue`);
    expect(res.status).toBe(201);
    expect(res.body.numero).toBe('FA-2026-000001');
    const f = (await get(admin, `/bo/billing/invoices/${invoiceId}`)).body;
    expect(f).toMatchObject({ statut: 'EMISE', numero: 'FA-2026-000001' });
    expect(f.echeance).toBeTruthy();
    const pdf = await getBin(admin, `/bo/billing/invoices/${invoiceId}/pdf`);
    expect(binary(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(binary(pdf)).digest('hex')).toBe(f.empreinte);
  });

  it('une facture émise ne se modifie plus, ni par l’API ni en base', async () => {
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/lines`, { libelle: 'Ajout', quantite: 1, unite: 'u', prixUnitaireHtCents: 1, motif: 'test' })).status).toBe(409);
    expect((await post(admin, '/bo/billing/drafts', { mois: '2026-08', entrepriseId: horizon })).body).toMatchObject({ crees: 0, ignores: 1 });
    await expect(sys('UPDATE facture SET total_ht_cents = 1 WHERE id = $1', [invoiceId])).rejects.toThrow(/modification interdite/);
    await expect(sys(`UPDATE facture SET cle_pdf = 'autre.pdf' WHERE id = $1`, [invoiceId])).rejects.toThrow(/modification interdite/);
  });

  it('un PDF perdu (disque éphémère) est régénéré à l’identique', async () => {
    const f = (await get(admin, `/bo/billing/invoices/${invoiceId}`)).body;
    const { rm } = await import('node:fs/promises');
    await rm(`.storage/${t.data.tenantId}/factures/${f.numero}.pdf`, { force: true });
    const pdf = await getBin(admin, `/bo/billing/invoices/${invoiceId}/pdf`);
    expect(createHash('sha256').update(binary(pdf)).digest('hex')).toBe(f.empreinte);
  });
});

describe('avoirs (FAC-04)', () => {
  it('avoir partiel, lié à la facture d’origine', async () => {
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/credit`, { montantHtCents: 15000 })).status).toBe(400);
    const res = await post(admin, `/bo/billing/invoices/${invoiceId}/credit`, { montantHtCents: 15000, motif: 'Livraison du 26 août offerte' });
    expect(res.status).toBe(201);
    expect(res.body.numero).toBe('AV-2026-000001');
    const av = (await get(admin, `/bo/billing/invoices/${res.body.id}`)).body;
    expect(av).toMatchObject({ type: 'AVOIR', statut: 'EMISE', totalHtCents: -15000, totalTtcCents: -18000, origineNumero: 'FA-2026-000001' });
    const f = (await get(admin, `/bo/billing/invoices/${invoiceId}`)).body;
    expect(f.statut).toBe('EMISE');
    expect(f.avoirs).toHaveLength(1);
  });

  it('refuse de créditer plus que le solde', async () => {
    expect((await post(admin, `/bo/billing/invoices/${invoiceId}/credit`, { montantHtCents: 214550, motif: 'Trop' })).status).toBe(422);
  });

  it('un avoir du solde annule la facture, et la période peut être refacturée', async () => {
    const res = await post(admin, `/bo/billing/invoices/${invoiceId}/credit`, { motif: 'Erreur de surface : refacturation' });
    expect(res.body.numero).toBe('AV-2026-000002');
    expect((await get(admin, `/bo/billing/invoices/${res.body.id}`)).body.totalHtCents).toBe(-199550);
    expect((await get(admin, `/bo/billing/invoices/${invoiceId}`)).body.statut).toBe('ANNULEE');
    const again = await post(admin, '/bo/billing/drafts', { mois: '2026-08', entrepriseId: horizon });
    expect(again.body.crees).toBe(1);
    const fresh = (await get(admin, `/bo/billing/invoices/${again.body.factures[0]}`)).body;
    // les livraisons libérées par l'annulation sont refacturées
    expect(fresh.totalHtCents).toBe(214550);
    expect((await post(admin, `/bo/billing/invoices/${fresh.id}/issue`)).body.numero).toBe('FA-2026-000002');
  });
});

describe('paiement', () => {
  it('pointe un virement reçu', async () => {
    const list = (await get(admin, '/bo/billing/invoices?statut=IMPAYEE')).body.items;
    expect(list).toHaveLength(1);
    expect((await post(admin, `/bo/billing/invoices/${list[0].id}/paid`, { date: '2026-09-20', moyen: 'VIREMENT', reference: 'VIR-123' })).status).toBe(201);
    expect((await get(admin, `/bo/billing/invoices/${list[0].id}`)).body).toMatchObject({ statut: 'PAYEE', payeLe: '2026-09-20' });
    expect((await post(admin, `/bo/billing/invoices/${list[0].id}/paid`, { date: '2026-09-20', moyen: 'VIREMENT' })).status).toBe(409);
  });
});

describe('instantanés (FAC-02)', () => {
  it('une période déjà facturée ne se corrige pas sans avoir', async () => {
    const res = await post(admin, '/bo/billing/occupation/correct', { entrepriseId: horizon, du: '2026-08-10', au: '2026-08-12', m2: 90, motif: 'Inventaire' });
    expect(res.status).toBe(409);
  });

  it('corrige une période non facturée, avec motif et trace', async () => {
    const res = await post(admin, '/bo/billing/occupation/correct', { entrepriseId: t.data.entreprises.autre, du: '2026-08-10', au: '2026-08-12', m2: 41, motif: 'Box oublié dans le calcul' });
    expect(res.status).toBe(201);
    const occ = (await get(admin, `/bo/billing/occupation?client=${t.data.entreprises.autre}&du=2026-08-01&au=2026-08-31`)).body;
    expect(occ.jours).toHaveLength(3);
    expect(occ.jours[0]).toMatchObject({ m2: 41, source: 'CORRECTION', motif: 'Box oublié dans le calcul' });
    // le journal d'audit n'est lisible que par le Super Admin (RLS)
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SUPER_ADMIN', true)`, [t.data.tenantId]);
    const audit = await owner.query(`SELECT motif FROM journal_audit WHERE action = 'INSTANTANE_CORRIGE'`);
    await owner.query('COMMIT');
    expect(audit.rows).toEqual([{ motif: 'Box oublié dans le calcul' }]);
  });
});

describe('tâches planifiées', () => {
  it('le 1er à 2 h : rattrapage des instantanés et brouillons du mois écoulé, une seule fois', async () => {
    const scheduler = t.app.get(BillingScheduler);
    const before = (await scheduler.runFor(t.data.tenantId, new Date('2026-10-01T00:30:00Z'))) as { instantanes: number; brouillons: { mois: string; crees: number } | null };
    expect(before.brouillons?.mois).toBe('2026-09');
    expect(before.brouillons?.crees).toBe(3);
    expect(before.instantanes).toBeGreaterThan(0);
    const again = await scheduler.runFor(t.data.tenantId, new Date('2026-10-01T00:40:00Z'));
    expect(again.brouillons).toBeNull();
    expect(again.emises).toEqual([]);
  });

  it('émission automatique à J+2, sauf brouillon bloqué', async () => {
    const drafts = (await get(admin, '/bo/billing/invoices?statut=BROUILLON')).body.items;
    expect(drafts).toHaveLength(3);
    const camille = drafts.find((d: { clientId: string }) => d.clientId === t.data.entreprises.particulier);
    await post(admin, `/bo/billing/invoices/${camille.id}/block`, { bloquee: true, motif: 'À revoir' });
    const scheduler = t.app.get(BillingScheduler);
    expect((await scheduler.runFor(t.data.tenantId, new Date('2026-10-02T08:00:00Z'))).emises).toEqual([]);
    const r = await scheduler.runFor(t.data.tenantId, new Date('2026-10-03T08:00:00Z'));
    expect(r.emises).toEqual(['FA-2026-000003', 'FA-2026-000004']); // Bâtir puis Horizon (ordre alphabétique)
    expect((await get(admin, '/bo/billing/invoices?statut=BROUILLON')).body.items).toHaveLength(1);
  });

  it('avant 2 h le 1er, rien n’est généré', async () => {
    const scheduler = t.app.get(BillingScheduler);
    const r = await scheduler.runFor(t.data.tenantId, new Date('2026-11-01T00:30:00Z')); // 1 h 30 à Paris
    expect(r.brouillons).toBeNull();
  });
});

describe('grilles et forfaits (FAC-01)', () => {
  it('une grille utilisée pour facturer ne se modifie plus : nouvelle version', async () => {
    const grilles = (await get(admin, '/bo/billing/grilles')).body.items;
    const b2b = grilles.find((g: { nom: string }) => g.nom === 'Sur-mesure B2B');
    expect(b2b.utilisee).toBe(true);
    const body = { nom: b2b.nom, type: b2b.type, valideDu: '2027-01-01', prixM2MoisCents: 1600, m2Minimum: 0, lignes: b2b.lignes };
    expect((await put(admin, `/bo/billing/grilles/${b2b.id}`, body)).status).toBe(409);
    const v2 = await post(admin, '/bo/billing/grilles', { ...body, baseId: b2b.id });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const after = (await get(admin, '/bo/billing/grilles')).body.items.filter((g: { nom: string }) => g.nom === 'Sur-mesure B2B');
    expect(after.map((g: { version: number; valideAu: string | null }) => [g.version, g.valideAu])).toEqual([
      [2, null],
      [1, '2026-12-31'],
    ]);
    expect((await post(admin, '/bo/billing/grilles', { ...body, baseId: b2b.id, valideDu: '2026-12-01' })).status).toBe(422);
  });

  it('un avenant ne s’applique qu’aux périodes suivantes et clôt le forfait en cours', async () => {
    const grille = (await get(admin, '/bo/billing/grilles')).body.items.find((g: { nom: string; version: number }) => g.nom === 'Sur-mesure B2B' && g.version === 2);
    const body = { entrepriseId: horizon, grilleId: grille.id, m2Inclus: 150, prixMensuelCents: 210000, prixM2DepassementCents: 1600, prestationsIncluses: { LIVRAISON: 3 }, dateDebut: '2026-09-15' };
    expect((await post(admin, '/bo/billing/forfaits', body)).status).toBe(422); // septembre déjà facturé
    const res = await post(admin, '/bo/billing/forfaits', { ...body, dateDebut: '2026-12-01', motif: 'Extension du programme' });
    expect(res.status).toBe(201);
    const forfaits = (await get(admin, `/bo/billing/forfaits?client=${horizon}`)).body.items;
    expect(forfaits.map((f: { m2Inclus: number; dateFin: string | null }) => [f.m2Inclus, f.dateFin])).toEqual([
      [150, null],
      [120, '2026-11-30'],
    ]);
  });
});

describe('documents du client (SUI-03)', () => {
  it('l’administrateur voit ses factures et avoirs émis, jamais les brouillons ni ceux des autres', async () => {
    const res = await get(t.data.users.b2bAdmin.email, '/me/documents');
    expect(res.status).toBe(200);
    const nums = res.body.items.map((d: { numero: string }) => d.numero).sort();
    expect(nums).toEqual(['AV-2026-000001', 'AV-2026-000002', 'FA-2026-000001', 'FA-2026-000002', 'FA-2026-000004']);
    expect((await get(t.data.users.b2bAdmin.email, '/me/documents?type=AVOIR')).body.total).toBe(2);
    const other = (await get(admin, `/bo/billing/invoices?client=${t.data.entreprises.autre}`)).body.items[0];
    expect((await get(t.data.users.b2bAdmin.email, `/me/documents/facture/${other.id}/pdf`)).status).toBe(404);
  });

  it('télécharge un PDF et une archive ZIP', async () => {
    const docs = (await get(t.data.users.b2bAdmin.email, '/me/documents')).body.items;
    const pdf = await getBin(t.data.users.b2bAdmin.email, `/me/documents/facture/${docs.find((d: { type: string }) => d.type === 'FACTURE').id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(binary(pdf).subarray(0, 4).toString()).toBe('%PDF');
    const z = await postBin(t.data.users.b2bAdmin.email, '/me/documents/zip', { items: docs.map((d: { type: string; id: string }) => ({ type: d.type, id: d.id })) });
    expect(z.status).toBe(201);
    expect(binary(z).subarray(0, 2).toString()).toBe('PK');
  });

  it('un B2B Utilisateur ne voit pas les factures', async () => {
    const res = await get(t.data.users.b2bUser.email, '/me/documents');
    expect(res.body.factures).toBe(false);
    expect(res.body.items.filter((d: { type: string }) => d.type !== 'BL')).toEqual([]);
    const inv = (await get(admin, `/bo/billing/invoices?client=${horizon}&type=FACTURE`)).body.items[0];
    expect((await get(t.data.users.b2bUser.email, `/me/documents/facture/${inv.id}/pdf`)).status).toBe(403);
  });
});

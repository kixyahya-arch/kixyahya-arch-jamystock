import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { formEncode, signWebhook, verifyWebhook } from '../src/payments/stripe.js';

/** ADM-04 : informations de facturation, carte / SEPA via Stripe, prélèvement des factures et webhooks. */
const SECRET = 'whsec_test_secret';
let t: TestContext;
let owner: pg.Client;
let payments: PaymentsService;
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

/** Faux Stripe : enregistre les appels et répond selon la route. */
const calls: { method: string; path: string; body: string; idem?: string }[] = [];
let declineNext = false;
function fakeStripe() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', path, body: String(init?.body ?? url.search), idem: headers['idempotency-key'] });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/customers') return json(200, { id: 'cus_123' });
    if (path === '/checkout/sessions') return json(200, { id: 'cs_1', url: 'https://checkout.stripe.test/c/pay/cs_1' });
    if (path.startsWith('/setup_intents/'))
      return json(200, { id: 'seti_1', payment_method: { id: 'pm_card', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } });
    if (path.startsWith('/payment_methods/')) return json(200, { id: 'pm_card', type: 'card' });
    if (path === '/payment_intents') {
      if (declineNext) {
        declineNext = false;
        return json(402, { error: { code: 'card_declined', message: 'Votre carte a été refusée.', payment_intent: { id: 'pi_declined' } } });
      }
      return json(200, { id: `pi_${calls.length}`, status: 'succeeded' });
    }
    return json(404, { error: { message: `route inconnue ${path}` } });
  });
}

const webhook = (event: object, secret = SECRET) => {
  const payload = JSON.stringify(event);
  return t.http().post('/api/v1/stripe/webhook').set('content-type', 'application/json').set('stripe-signature', signWebhook(payload, secret)).send(payload);
};

async function issuedInvoice(entrepriseId: string, ttc = 6000): Promise<string> {
  const id = crypto.randomUUID();
  await sys(
    `INSERT INTO facture (id, tenant_id, entreprise_id, type, statut, total_ht_cents, tva_cents, total_ttc_cents) VALUES ($1,$2,$3,'FACTURE','BROUILLON',$4,$5,$6)`,
    [id, t.data.tenantId, entrepriseId, ttc - ttc / 6, ttc / 6, ttc],
  );
  await sys(
    `INSERT INTO ligne_facture (tenant_id, facture_id, type, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, total_ht_cents) VALUES ($1,$2,'ABONNEMENT','Abonnement',1,'mois',$3,20,$3)`,
    [t.data.tenantId, id, ttc - ttc / 6],
  );
  const r = await post(t.data.users.superAdmin.email, `/bo/billing/invoices/${id}/issue`);
  expect(r.status).toBe(201);
  return id;
}

beforeAll(async () => {
  t = await bootstrap({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: 'https://stripe.test', PUBLIC_URL: 'https://app.jamystock.test' });
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  payments = t.app.get(PaymentsService);
  fakeStripe();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await owner.end();
  await t.app.close();
});

describe('outils Stripe', () => {
  it('encode les paramètres imbriqués et vérifie les signatures', () => {
    expect(formEncode({ a: 1, b: ['x', 'y'], c: { d: 'é' }, e: undefined, f: [{ g: 2 }] })).toBe('a=1&b%5B0%5D=x&b%5B1%5D=y&c%5Bd%5D=%C3%A9&f%5B0%5D%5Bg%5D=2');
    const body = Buffer.from('{"id":"evt_1","type":"x","data":{"object":{"id":"o"}}}');
    expect(verifyWebhook(body, signWebhook(body.toString(), 's'), 's').id).toBe('evt_1');
    expect(() => verifyWebhook(body, signWebhook(body.toString(), 'autre'), 's')).toThrow('Signature invalide');
    expect(() => verifyWebhook(body, signWebhook(body.toString(), 's', 1000), 's')).toThrow('trop ancienne');
  });
});

describe('informations de facturation (ADM-04)', () => {
  it('réservées au titulaire du compte', async () => {
    expect((await get(t.data.users.b2bUser.email, '/me/billing')).status).toBe(403);
    const b2c = await get(t.data.users.b2c.email, '/me/billing');
    expect(b2c.body).toMatchObject({ type: 'B2C', moyensProposes: ['CARTE'], paiementEnLigne: true, moyenPaiement: null });
    expect((await get(t.data.users.b2bAdmin.email, '/me/billing')).body.moyensProposes).toEqual(['SEPA', 'VIREMENT']);
  });

  it('valide et enregistre les informations, avec trace', async () => {
    const admin = t.data.users.b2bAdmin.email;
    expect((await put(admin, '/me/billing', { siret: '12345678900012' })).status).toBe(422);
    expect((await put(admin, '/me/billing', { moyenPaiement: 'SEPA' })).status).toBe(422); // pas encore de mandat
    const ok = await put(admin, '/me/billing', { bonDeCommande: 'PO-2026-117', emailFacturation: 'compta@horizon.test', adresseFacturation: '12 rue de la Paix, 75002 Paris', moyenPaiement: 'VIREMENT' });
    expect(ok.status).toBe(200);
    const b = (await get(admin, '/me/billing')).body;
    expect(b).toMatchObject({ bonDeCommande: 'PO-2026-117', emailFacturation: 'compta@horizon.test', adresseFacturation: '12 rue de la Paix, 75002 Paris', moyenPaiement: 'VIREMENT' });
    expect((await put(t.data.users.b2c.email, '/me/billing', { moyenPaiement: 'VIREMENT' })).status).toBe(422);
    const audit = await sys<{ action: string }>(`SELECT action FROM journal_audit WHERE objet_id = $1`, [t.data.entreprises.promoteur], 'SUPER_ADMIN');
    expect(audit.rows.map((a) => a.action)).toContain('FACTURATION_MODIFIEE');
  });

  it('rappelle le bon de commande sur la facture et prévient le contact facturation', async () => {
    const id = await issuedInvoice(t.data.entreprises.promoteur);
    const f = await sys<{ bon_de_commande: string }>('SELECT bon_de_commande FROM facture WHERE id = $1', [id]);
    expect(f.rows[0]!.bon_de_commande).toBe('PO-2026-117');
    const n = await sys<{ destinataire_adresse: string; variables: { prelevement: boolean } }>(`SELECT destinataire_adresse, variables FROM notification WHERE modele = 'FACTURE_EMISE' AND variables->>'factureId' = $1`, [id]);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({ destinataire_adresse: 'compta@horizon.test', variables: { prelevement: false } });
  });
});

describe('carte bancaire et prélèvement (ADM-04)', () => {
  it('ouvre la page Stripe d’enregistrement de la carte', async () => {
    const b2c = t.data.users.b2c.email;
    expect((await post(b2c, '/me/billing/payment-method', { type: 'SEPA' })).status).toBe(422);
    const r = await post(b2c, '/me/billing/payment-method', { type: 'CARTE' });
    expect(r.status).toBe(200);
    expect(r.body.url).toContain('checkout.stripe.test');
    const session = calls.find((c) => c.path === '/checkout/sessions')!;
    expect(decodeURIComponent(session.body)).toContain('mode=setup');
    expect(decodeURIComponent(session.body)).toContain('payment_method_types[0]=card');
    expect(decodeURIComponent(session.body)).toContain('success_url=https://app.jamystock.test/#/compte?paiement=enregistre');
    // le client Stripe est créé une fois, puis réutilisé
    await post(b2c, '/me/billing/payment-method', { type: 'CARTE' });
    expect(calls.filter((c) => c.path === '/customers')).toHaveLength(1);
  });

  it('enregistre la carte à la réception du webhook, une seule fois', async () => {
    expect((await webhook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }, 'mauvais')).status).toBe(400);
    const event = {
      id: 'evt_setup',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'setup', setup_intent: 'seti_1', metadata: { entreprise_id: t.data.entreprises.particulier, tenant_id: t.data.tenantId } } },
    };
    expect((await webhook(event)).body).toEqual({ traite: true });
    expect((await webhook(event)).body).toEqual({ traite: false });
    const b = (await get(t.data.users.b2c.email, '/me/billing')).body;
    expect(b).toMatchObject({ moyenPaiement: 'CARTE', moyenDetail: { marque: 'visa', derniers4: '4242', expire: '04/2030' } });
  });

  it('prélève la facture émise et la marque payée au webhook', async () => {
    const id = await issuedInvoice(t.data.entreprises.particulier, 6000);
    const notif = await sys<{ variables: { prelevement: boolean } }>(`SELECT variables FROM notification WHERE modele = 'FACTURE_EMISE' AND variables->>'factureId' = $1`, [id]);
    expect(notif.rows[0]!.variables.prelevement).toBe(true);
    const res = await payments.collectDue(t.data.tenantId);
    expect(res).toEqual({ tentes: 1, refuses: 0 });
    const pi = calls.filter((c) => c.path === '/payment_intents').at(-1)!;
    expect(pi.idem).toBe(`prelevement-${id}`);
    expect(decodeURIComponent(pi.body)).toContain('off_session=true');
    expect((await payments.collectDue(t.data.tenantId)).tentes).toBe(0); // une seule tentative automatique

    const ref = (await sys<{ prelevement_ref: string }>('SELECT prelevement_ref FROM facture WHERE id = $1', [id])).rows[0]!.prelevement_ref;
    const paid = { id: 'evt_paid', type: 'payment_intent.succeeded', data: { object: { id: ref, amount_received: 6000, payment_method: 'pm_card', metadata: { facture_id: id, tenant_id: t.data.tenantId } } } };
    await webhook(paid);
    await webhook({ ...paid, id: 'evt_paid_bis' }); // même paiement, autre événement : pas de double comptage
    const f = await sys<{ statut: string }>('SELECT statut FROM facture WHERE id = $1', [id]);
    expect(f.rows[0]!.statut).toBe('PAYEE');
    const p = await sys<{ moyen: string; montant_cents: number }>('SELECT moyen, montant_cents FROM paiement WHERE facture_id = $1', [id]);
    expect(p.rows).toEqual([{ moyen: 'CB', montant_cents: 6000 }]);
    const recu = await sys(`SELECT 1 FROM notification WHERE modele = 'PAIEMENT_RECU' AND variables->>'factureId' = $1`, [id]);
    expect(recu.rowCount).toBe(1);
  });

  it('un refus prévient le client une seule fois et la facture reste à régler', async () => {
    const id = await issuedInvoice(t.data.entreprises.particulier, 4800);
    declineNext = true;
    expect(await payments.collectDue(t.data.tenantId)).toEqual({ tentes: 1, refuses: 1 });
    await webhook({
      id: 'evt_fail',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_declined', last_payment_error: { message: 'Votre carte a été refusée.' }, metadata: { facture_id: id, tenant_id: t.data.tenantId } } },
    });
    const f = await sys<{ statut: string; prelevement_erreur: string }>('SELECT statut, prelevement_erreur FROM facture WHERE id = $1', [id]);
    expect(f.rows[0]).toEqual({ statut: 'EMISE', prelevement_erreur: 'Votre carte a été refusée.' });
    const n = await sys(`SELECT 1 FROM notification WHERE modele = 'PAIEMENT_ECHOUE' AND variables->>'factureId' = $1`, [id]);
    expect(n.rowCount).toBe(1);
    // paiement en ligne de la facture refusée
    const pay = await post(t.data.users.b2c.email, `/me/invoices/${id}/pay`);
    expect(pay.body.url).toContain('checkout.stripe.test');
    expect(decodeURIComponent(calls.at(-1)!.body)).toContain(`payment_intent_data[metadata][facture_id]=${id}`);
    expect((await post(t.data.users.otherB2bAdmin.email, `/me/invoices/${id}/pay`)).status).toBe(404);
  });
});

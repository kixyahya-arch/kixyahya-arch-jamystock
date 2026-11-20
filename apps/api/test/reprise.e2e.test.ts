import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';
import { isPrivateHost } from '../src/reprise/reprise.controller.js';

/** Reprise des données de l'ancien logiciel : comptes clients, stock, photos. */
let t: TestContext;
let owner: pg.Client;
let server: http.Server;
let photoBase: string;
let admin: string;
let quai: string;
let rack: { id: string; code: string };

const as = async (email: string) => `Bearer ${await t.login(email)}`;
const get = async (email: string, path: string) =>
  t
    .http()
    .get(`/api/v1${path}`)
    .set('Authorization', await as(email));
const post = async (email: string, path: string, body: unknown = {}) =>
  t
    .http()
    .post(`/api/v1${path}`)
    .set('Authorization', await as(email))
    .send(body as object);

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

// 1 × 1 px PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  t = await bootstrap({ REPRISE_PHOTOS_LOCAL: 'on' });
  admin = t.data.users.superAdmin.email;
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    } else if (req.url?.endsWith('.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  photoBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  quai = (await sys<{ id: string }>(`SELECT e.id FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.type = 'RECEPTION' AND e.adressable LIMIT 1`))
    .rows[0]!.id;
  rack = (await sys<{ id: string; code: string }>(`SELECT id, code FROM emplacement WHERE type = 'RACK' AND adressable ORDER BY code LIMIT 1`)).rows[0]!;
});
afterAll(async () => {
  server.close();
  await owner.end();
  await t.app.close();
});

describe('reprise des comptes clients', () => {
  const csv = [
    'Société;Type;SIRET;Contact;E-mail;Téléphone;Projets',
    'Promotion Horizon;Professionnel;;Mme Durand;nouvelle.dsg@horizon.test;0601020304;Les Tilleuls, Résidence Bellevue',
    'Cabinet Martel;Professionnel;;M. Martel;contact@martel.test;;',
    'Julie Petit;Particulier;;Julie Petit;julie@exemple.test;;',
    'Autre;;;;camille@exemple.test;;',
  ].join('\n');

  it('aperçu : rien n’est écrit, l’existant est reconnu, un e-mail d’un autre compte est refusé', async () => {
    const res = await post(admin, '/bo/reprise/clients', { csv });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lignes: 4, valides: 3, clientsCrees: 2, contactsCrees: 3, nbErreurs: 1 });
    expect(res.body.erreurs[0]).toMatchObject({ line: 5, message: expect.stringMatching(/appartient déjà/) });
    expect(res.body.apercu[0]).toMatchObject({ client: 'Promotion Horizon SAS', action: 'EXISTANT' });
    const n = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM entreprise WHERE nom = 'Cabinet Martel'`);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('import : comptes et contacts invités, sans e-mail tant que la bascule n’est pas lancée', async () => {
    const res = await post(admin, '/bo/reprise/clients', { csv, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clientsCrees: 2, contactsCrees: 3, invitations: 0 });
    const u = await sys<{ statut: string; role: string; nom: string }>(`SELECT statut, role, nom FROM utilisateur WHERE email = 'julie@exemple.test'`);
    expect(u.rows[0]).toMatchObject({ statut: 'INVITE', role: 'B2C' });
    const p = await sys<{ nom: string }>(`SELECT nom FROM projet WHERE entreprise_id = $1 ORDER BY nom`, [t.data.entreprises.promoteur]);
    expect(p.rows.map((r) => r.nom)).toContain('Résidence Bellevue');
    expect(p.rows.filter((r) => r.nom === 'Les Tilleuls')).toHaveLength(1);
    // rejouer ne crée rien de plus
    const again = await post(admin, '/bo/reprise/clients', { csv: csv.split('\n').slice(0, 4).join('\n'), dryRun: false });
    expect(again.body).toMatchObject({ clientsCrees: 0, contactsCrees: 0 });
  });

  it('bascule : un lien d’activation par contact repris, une seule fois', async () => {
    const res = await post(admin, '/bo/reprise/invitations');
    expect(res.status).toBe(200);
    expect(res.body.invitations).toBe(3);
    expect((await post(admin, '/bo/reprise/invitations')).body.invitations).toBe(0);
  });

  it('réservé au Super Admin', async () => {
    expect((await post(t.data.users.dispatcher.email, '/bo/reprise/clients', { csv })).status).toBe(403);
    expect((await post(t.data.users.b2bAdmin.email, '/bo/reprise/articles', { csv })).status).toBe(403);
  });
});

describe('reprise du stock', () => {
  const csv = () =>
    [
      'Désignation;Nom technique;Code-barres;Client;Projet;Catégorie;Quantité;Emplacement;Longueur (cm);Largeur (cm);Hauteur (cm);État;Photo',
      `Canapé d’angle;CAN-01;3700000000017;Cabinet Martel;;Mobilier de salon;1;${rack.code};250;180;85;bon;${photoBase}/canape.png`,
      `Chaise bistrot;CHA-07;;Cabinet Martel;;Chaise;3;Z-INCONNU;45;45;80;neuf;${photoBase}/chaise.png ${photoBase}/absente.jpg`,
      'Armoire;ARM-01;;Nouveau Client SARL;Chantier Nord;;1;;;;;usé;',
      `Lampe;LAM-01;;Cabinet Martel;;;1;;;;;;${photoBase}/page.html`,
      'Table;TAB-01;;Cabinet Martel;;;0;;;;;;',
    ].join('\n');

  it('aperçu : quantités éclatées, emplacements inconnus signalés, clients à créer listés', async () => {
    const res = await post(admin, '/bo/reprise/articles', { csv: csv(), depotId: t.data.depotId, emplacementParDefautId: quai });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valides: 4,
      nbErreurs: 0,
      articlesACreer: 6,
      dejaRepris: 0,
      nouveauxClients: ['Nouveau Client SARL'],
      photos: 1 + 3 * 2 + 1,
    });
    expect(res.body.avertissements).toEqual([{ line: 3, message: 'emplacement « Z-INCONNU » absent du dépôt : rangé à l’emplacement par défaut' }]);
    expect(res.body.colonnes).toMatchObject({ libelle: 'Désignation', codeBarres: 'Code-barres' });
  });

  it('sans création de client, les lignes d’un client inconnu bloquent l’import', async () => {
    const res = await post(admin, '/bo/reprise/articles', {
      csv: csv(),
      depotId: t.data.depotId,
      emplacementParDefautId: quai,
      creerClients: false,
      dryRun: false,
    });
    expect(res.status).toBe(422);
  });

  it('import : articles en stock, un QR chacun, mouvement de réception, rejouable', async () => {
    const res = await post(admin, '/bo/reprise/articles', { csv: csv(), depotId: t.data.depotId, emplacementParDefautId: quai, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.cree).toBe(6);
    const a = await sys<{
      libelle: string;
      statut: string;
      emplacement_courant_id: string;
      longueur_m: number;
      ancien_code: string | null;
      qr_code: string;
      mouvements: number;
      client: string;
    }>(
      `SELECT a.libelle, a.statut, a.emplacement_courant_id, a.longueur_m, a.ancien_code, a.qr_code, e.nom AS client,
              (SELECT count(*)::int FROM mouvement m WHERE m.article_id = a.id AND m.type = 'RECEPTION') AS mouvements
         FROM article a JOIN entreprise e ON e.id = a.entreprise_id WHERE a.origine_import IS NOT NULL ORDER BY a.libelle`,
    );
    expect(a.rows.map((r) => r.libelle)).toEqual([
      'Armoire',
      'Canapé d’angle',
      'Chaise bistrot (1/3)',
      'Chaise bistrot (2/3)',
      'Chaise bistrot (3/3)',
      'Lampe',
    ]);
    expect(a.rows.every((r) => r.statut === 'EN_STOCK' && r.mouvements === 1 && /^A[A-Z2-9]{10}$/.test(r.qr_code))).toBe(true);
    expect(new Set(a.rows.map((r) => r.qr_code)).size).toBe(6);
    const canape = a.rows.find((r) => r.libelle === 'Canapé d’angle')!;
    expect(canape).toMatchObject({ emplacement_courant_id: rack.id, longueur_m: 2.5, ancien_code: '3700000000017', client: 'Cabinet Martel' });
    expect(a.rows.find((r) => r.libelle === 'Chaise bistrot (1/3)')!.emplacement_courant_id).toBe(quai);
    expect(a.rows.find((r) => r.libelle === 'Armoire')!.client).toBe('Nouveau Client SARL');

    const again = await post(admin, '/bo/reprise/articles', { csv: csv(), depotId: t.data.depotId, emplacementParDefautId: quai, dryRun: false });
    expect(again.body).toMatchObject({ cree: 0, articlesACreer: 0, dejaRepris: 6 });
  });

  it('les objets repris apparaissent dans l’Espace Client du compte', async () => {
    const martel = (await sys<{ id: string }>(`SELECT id FROM entreprise WHERE nom = 'Cabinet Martel'`)).rows[0]!.id;
    const n = await sys<{ n: number }>(`SELECT count(*)::int AS n FROM article WHERE entreprise_id = $1 AND statut = 'EN_STOCK'`, [martel]);
    expect(n.rows[0]!.n).toBe(5);
  });

  it('objets installés chez le client : hors dépôt, rattachés au site ; objets sortis ignorés', async () => {
    const csv2 = [
      'Désignation;Référence;Client;Projet;Situation;Quantité',
      'Canapé témoin;MS-1;Cabinet Martel;Appartement témoin Clamart;chez le client;2',
      'Lampe jetée;MS-2;Cabinet Martel;;sorti;1',
      'Bureau stock;MS-3;Cabinet Martel;;en stock;1',
      'Chaise;MS-4;Cabinet Martel;;perdue;1',
    ].join('\n');
    const dry = await post(admin, '/bo/reprise/articles', { csv: csv2, depotId: t.data.depotId, emplacementParDefautId: quai });
    expect(dry.body).toMatchObject({ articlesACreer: 3, chezLeClient: 2, nbErreurs: 1 });
    expect(dry.body.erreurs[0].message).toMatch(/situation « perdue » inconnue/);
    const ok = csv2.split('\n').slice(0, 4).join('\n');
    const res = await post(admin, '/bo/reprise/articles', { csv: ok, depotId: t.data.depotId, emplacementParDefautId: quai, dryRun: false });
    expect(res.body.cree).toBe(3);
    const a = await sys<{ libelle: string; statut: string; emplacement_courant_id: string | null; projet: string | null; mouvements: string }>(
      `SELECT a.libelle, a.statut, a.emplacement_courant_id, p.nom AS projet,
              (SELECT string_agg(m.type::text, ',' ORDER BY m.horodatage_terminal) FROM mouvement m WHERE m.article_id = a.id) AS mouvements
         FROM article a LEFT JOIN projet p ON p.id = a.projet_id WHERE a.reference_interne IN ('MS-1','MS-2','MS-3') ORDER BY a.libelle`,
    );
    expect(a.rows).toEqual([
      { libelle: 'Bureau stock', statut: 'EN_STOCK', emplacement_courant_id: quai, projet: null, mouvements: 'RECEPTION' },
      {
        libelle: 'Canapé témoin (1/2)',
        statut: 'RESTITUE',
        emplacement_courant_id: null,
        projet: 'Appartement témoin Clamart',
        mouvements: 'RECEPTION,LIVRAISON',
      },
      {
        libelle: 'Canapé témoin (2/2)',
        statut: 'RESTITUE',
        emplacement_courant_id: null,
        projet: 'Appartement témoin Clamart',
        mouvements: 'RECEPTION,LIVRAISON',
      },
    ]);
  });

  it('photos : téléchargées par lots, échecs définitifs mis de côté', async () => {
    const r1 = await post(admin, '/bo/reprise/photos', { lot: 100 });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ telechargees: 4, echecs: 4, restant: 0 });
    const etat = await get(admin, '/bo/reprise');
    expect(etat.body).toMatchObject({ articles: 9, photos: { TELECHARGEE: 4, ECHEC: 4, A_TELECHARGER: 0 } });
    expect(etat.body.echecs.map((e: { erreur: string }) => e.erreur).sort()).toEqual(['HTTP 404', 'HTTP 404', 'HTTP 404', 'pas une image (text/html)']);
    const ph = await sys<{ n: number }>(
      `SELECT count(*)::int AS n FROM photo p JOIN article a ON a.id = p.article_id WHERE a.origine_import IS NOT NULL AND p.televersee`,
    );
    expect(ph.rows[0]!.n).toBe(4);
  });
});

describe('adresses de photos', () => {
  it('refuse les adresses locales et privées', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.2', '192.168.1.1', '172.20.0.1', '169.254.169.254', '[::1]', 'db.internal'])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of ['cdn.cloud.monstock.net', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h)).toBe(false);
  });
});

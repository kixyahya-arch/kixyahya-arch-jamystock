import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type TestContext } from './setup.js';
import { tvaFromSiren } from '../src/backoffice/sirene.service.js';

/** CLI-01 : vérification du SIRET auprès du répertoire Sirene (service simulé : les tests ne sortent pas sur Internet). */
let t: TestContext;
let fake: Server;
const SIRET = '73282932000074';

beforeAll(async () => {
  fake = createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams.get('q');
    res.setHeader('Content-Type', 'application/json');
    if (q === SIRET) {
      res.end(
        JSON.stringify({
          results: [
            {
              siren: '732829320',
              nom_complet: 'PROMOTION HORIZON SAS',
              etat_administratif: 'A',
              siege: { siret: SIRET, adresse: '1 RUE DE LA PAIX 75002 PARIS', etat_administratif: 'A' },
              matching_etablissements: [{ siret: SIRET, adresse: '1 RUE DE LA PAIX 75002 PARIS', etat_administratif: 'A' }],
            },
          ],
        }),
      );
    } else res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  t = await bootstrap({ SIRENE: 'on', SIRENE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` });
});
afterAll(async () => {
  await t.app.close();
  fake.close();
});

const check = async (siret: string, email = t.data.users.superAdmin.email) =>
  t.http().get(`/api/v1/bo/sirene/${siret}`).set('Authorization', `Bearer ${await t.login(email)}`);

describe('vérification SIRET (CLI-01)', () => {
  it('un SIRET connu renvoie raison sociale, adresse, activité et TVA intracommunautaire', async () => {
    const res = await check('732 829 320 00074');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statut: 'TROUVE',
      siret: SIRET,
      siren: '732829320',
      nom: 'PROMOTION HORIZON SAS',
      adresse: '1 RUE DE LA PAIX 75002 PARIS',
      actif: true,
      tva: tvaFromSiren('732829320'),
    });
  });

  it('un SIRET inconnu ou mal formé est signalé sans appel inutile', async () => {
    expect((await check('40483304800014')).body.statut).toBe('INTROUVABLE');
    expect((await check('12345678900012')).body.statut).toBe('INVALIDE');
  });

  it('réservé au Super Admin', async () => {
    expect((await check(SIRET, t.data.users.dispatcher.email)).status).toBe(403);
  });

  it('calcule la clé de TVA française', () => {
    expect(tvaFromSiren('404833048')).toBe('FR83404833048');
  });
});

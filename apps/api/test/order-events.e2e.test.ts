import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type TestContext } from './setup.js';

/** SUI-01 : la page de suivi reçoit les changements de statut en direct (SSE), sans rechargement. */
let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await bootstrap();
  const server = t.app.getHttpServer();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await t.app.close();
});

/** Ouvre un flux et renvoie les évènements « statut » reçus au fil de l'eau. */
async function open(path: string, token: string) {
  const ctrl = new AbortController();
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const events: unknown[] = [];
  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (block.includes('event: statut') && data) events.push(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        /* flux fermé */
      }
    })();
  }
  return { res, events, close: () => ctrl.abort() };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe('suivi des commandes en direct (SUI-01)', () => {
  it('un changement de statut arrive tout de suite sur la page de la commande et sur la liste', async () => {
    const token = await t.login(t.data.users.b2bAdmin.email);
    const created = await t
      .http()
      .post('/api/v1/collections')
      .set('Authorization', `Bearer ${token}`)
      .send({ projetId: t.data.projets.tilleuls, adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' }, dateSouhaitee: '2027-01-20', description: 'Cartons' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const one = await open(`/orders/${id}/events`, token);
    const all = await open('/orders-events', token);
    expect(one.res.status).toBe(200);
    expect(one.res.headers.get('content-type')).toContain('text/event-stream');
    await new Promise((r) => setTimeout(r, 100));

    const cancel = await t.http().post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${token}`).send({ motif: 'Plus nécessaire' });
    expect(cancel.status).toBeLessThan(300);
    await waitFor(() => one.events.length > 0 && all.events.length > 0);
    expect(one.events[0]).toEqual({ id, statut: 'ANNULEE' });
    expect(all.events[0]).toEqual({ id, statut: 'ANNULEE' });
    one.close();
    all.close();
  });

  it('un autre client ne peut pas écouter ma commande, et ne reçoit rien de moi', async () => {
    const token = await t.login(t.data.users.b2bAdmin.email);
    const other = await t.login(t.data.users.otherB2bAdmin.email);
    const created = await t
      .http()
      .post('/api/v1/collections')
      .set('Authorization', `Bearer ${token}`)
      .send({ projetId: t.data.projets.tilleuls, adresse: { libelle: '1 allée des Tilleuls, 92140 Clamart' }, dateSouhaitee: '2027-01-21', description: 'Cartons' });
    const id = created.body.id as string;
    const spy = await open(`/orders/${id}/events`, other);
    expect(spy.res.status).toBe(404);
    const feed = await open('/orders-events', other);
    await new Promise((r) => setTimeout(r, 100));
    await t.http().post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${token}`).send({ motif: 'Plus nécessaire' });
    await new Promise((r) => setTimeout(r, 400));
    expect(feed.events).toEqual([]);
    feed.close();
  });
});

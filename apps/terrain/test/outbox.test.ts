import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../src/lib/db';
import { enqueue, enqueuePhoto, flush, onRejected, refreshCounts, rejectedItems } from '../src/lib/outbox';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let handler: (c: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const okAll = (c: Call) => {
  if (c.url.endsWith('/field/sync')) {
    const { actions } = c.body as { actions: { key: string }[] };
    return json(200, { results: actions.map((a) => ({ key: a.key, status: 'OK' })) });
  }
  return new Response(null, { status: 204 });
};
const syncCalls = () => calls.filter((c) => c.url.endsWith('/field/sync'));

beforeEach(async () => {
  await resetDb();
  calls = [];
  handler = okAll;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(c);
    return handler(c);
  });
});
afterEach(() => vi.unstubAllGlobals());

const pick = (n: number) => ({ type: 'PICK' as const, payload: { missionId: '0190a0a0-0000-7000-8000-000000000001', articleQr: `A${String(n).padStart(10, '0')}` } });

describe('file d’envoi hors-ligne (§7.5)', () => {
  it('garde les actions tant que le réseau manque, puis les envoie dans l’ordre des gestes', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await enqueue(pick(1), new Date('2026-11-16T08:00:00Z'));
    await enqueue(pick(2), new Date('2026-11-16T08:00:05Z'));
    await flush();
    expect((await refreshCounts()).pending).toBe(2);

    handler = okAll;
    calls = [];
    await flush();
    expect((await refreshCounts()).pending).toBe(0);
    const sent = (syncCalls()[0]!.body as { actions: { at: string; action: { payload: { articleQr: string } } }[] }).actions;
    expect(sent.map((a) => a.action.payload.articleQr)).toEqual(['A0000000001', 'A0000000002']);
    expect(sent[0]!.at).toBe('2026-11-16T08:00:00.000Z');
  });

  it('renvoie la même clé après une coupure : le serveur peut dédoublonner', async () => {
    let first = true;
    handler = (c) => {
      if (first) {
        first = false;
        throw new TypeError('connexion coupée');
      }
      return okAll(c);
    };
    await enqueue(pick(1));
    await flush();
    await flush();
    const keys = syncCalls().map((c) => (c.body as { actions: { key: string }[] }).actions[0]!.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('met de côté une action refusée par le serveur et prévient l’écran', async () => {
    handler = (c) => {
      if (!c.url.endsWith('/field/sync')) return new Response(null, { status: 204 });
      const { actions } = c.body as { actions: { key: string }[] };
      return json(200, { results: actions.map((a) => ({ key: a.key, status: 'ERROR', code: 'ARTICLE_HORS_COMMANDE', message: 'Article hors commande' })) });
    };
    const seen: string[] = [];
    const off = onRejected((_item, r) => seen.push(r.code));
    await enqueue(pick(1));
    await flush();
    off();
    const s = await refreshCounts();
    expect(s.pending).toBe(0);
    expect(s.rejected).toBe(1);
    expect(seen).toEqual(['ARTICLE_HORS_COMMANDE']);
    expect((await rejectedItems())[0]!.lastError?.message).toBe('Article hors commande');
  });

  it('isole une action mal formée au lieu de bloquer toute la file', async () => {
    handler = (c) => {
      if (!c.url.endsWith('/field/sync')) return new Response(null, { status: 204 });
      const { actions } = c.body as { actions: { key: string; action: { payload: { articleQr: string } } }[] };
      if (actions.some((a) => a.action.payload.articleQr === 'A0000000002'))
        return json(400, { error: { code: 'VALIDATION', message: 'Requête invalide' } });
      return okAll(c);
    };
    await enqueue(pick(1));
    await enqueue(pick(2));
    await enqueue(pick(3));
    await flush();
    const s = await refreshCounts();
    expect(s.pending).toBe(0);
    expect(s.rejected).toBe(1);
    expect((await rejectedItems())[0]!.action).toMatchObject({ payload: { articleQr: 'A0000000002' } });
  });

  it('envoie les photos après les données, BL et réserves en premier', async () => {
    await enqueuePhoto('photo-reception', new Blob(['r'], { type: 'image/webp' }), 1);
    await enqueuePhoto('photo-bl', new Blob(['b'], { type: 'image/webp' }), 0);
    await enqueue(pick(1));
    await flush();
    const order = calls.map((c) => c.url.replace('/api/v1', ''));
    expect(order).toEqual(['/field/sync', '/field/photos/photo-bl', '/field/photos/photo-reception']);
    expect((await refreshCounts()).photos).toBe(0);
  });

  it('garde une photo dont l’action n’est pas encore arrivée (404) pour le prochain envoi', async () => {
    handler = (c) => (c.url.includes('/field/photos/') ? json(404, { error: { code: 'NOT_FOUND', message: 'Photo inconnue' } }) : okAll(c));
    await enqueuePhoto('photo-x', new Blob(['x'], { type: 'image/webp' }));
    await flush();
    expect((await refreshCounts()).photos).toBe(1);
  });
});

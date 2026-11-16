import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { bootstrap, OWNER_URL, type TestContext } from './setup.js';

let t: TestContext;
beforeAll(async () => {
  t = await bootstrap();
});
afterAll(async () => {
  await t.app.close();
});

describe('authentification (§7.3)', () => {
  it('refuse un mauvais mot de passe sans révéler le compte', async () => {
    const bad = await t.http().post('/api/v1/auth/login').send({ email: t.data.users.b2c.email, password: 'faux' });
    const unknown = await t.http().post('/api/v1/auth/login').send({ email: 'inconnu@x.test', password: 'faux' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('exige un jeton sur les routes protégées', async () => {
    expect((await t.http().get('/api/v1/articles')).status).toBe(401);
    expect((await t.http().get('/health')).status).toBe(200);
  });

  it('fait tourner le jeton de rafraîchissement et détecte sa réutilisation', async () => {
    const login = await t.http().post('/api/v1/auth/login').send({ email: t.data.users.b2c.email, password: t.data.password });
    expect(login.status).toBe(200);
    const r1 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // réutiliser l'ancien jeton révoque toute la famille, y compris le nouveau
    const replay = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(replay.status).toBe(401);
    const r2 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('coupe immédiatement les sessions d’un utilisateur désactivé (ADM-03)', async () => {
    const token = await t.login(t.data.users.b2bUserNoOrder.email);
    expect((await t.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const c = new pg.Client({ connectionString: OWNER_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [t.data.tenantId]);
    await c.query(`UPDATE utilisateur SET session_version = session_version + 1 WHERE id = $1`, [t.data.users.b2bUserNoOrder.id]);
    await c.query('COMMIT');
    await c.end();
    expect((await t.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('applique la matrice de permissions', async () => {
    const driver = await t.login(t.data.users.driver.email);
    const res = await t.http().post('/api/v1/cart/items').set('Authorization', `Bearer ${driver}`).send({ articleIds: [t.data.articles.tilleuls[0]] });
    expect(res.status).toBe(403);
  });
});

import pg from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { migrate } from '../src/db/migrate.js';
import { seed, type SeedResult } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const OWNER_URL = process.env.TEST_DATABASE_URL ?? 'postgres://jamystock:jamystock@localhost:5432/jamystock_test';
export const APP_URL = process.env.TEST_APP_DATABASE_URL ?? 'postgres://jamystock_api:jamystock_api@localhost:5432/jamystock_test';

export async function resetDatabase(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(OWNER_URL, () => undefined);
}

export interface TestContext {
  app: INestApplication;
  data: SeedResult;
  http: () => ReturnType<typeof request>;
  login: (email: string) => Promise<string>;
}

export async function bootstrap(env: Record<string, string> = {}): Promise<TestContext> {
  await resetDatabase();
  const data = await seed(OWNER_URL);
  const config = loadConfig({ APP_DATABASE_URL: APP_URL, JWT_SECRET: 'test-secret-test-secret-test-secret-123', TENANT_ID: data.tenantId, ...env });
  const app = await createApp(config);
  await app.init();
  const http = () => request(app.getHttpServer());
  const tokens = new Map<string, string>();
  const login = async (email: string) => {
    const cached = tokens.get(email);
    if (cached) return cached;
    const res = await http().post('/api/v1/auth/login').send({ email, password: data.password });
    if (res.status !== 200) throw new Error(`login ${email} : ${res.status} ${JSON.stringify(res.body)}`);
    tokens.set(email, res.body.accessToken);
    return res.body.accessToken as string;
  };
  return { app, data, http, login };
}

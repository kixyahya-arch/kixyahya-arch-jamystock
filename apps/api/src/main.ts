import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { appUrlFrom } from './db/provision.js';

// Hébergement : l'URL de l'API peut être dérivée de l'URL propriétaire et du mot de passe du rôle applicatif.
if (!process.env.APP_DATABASE_URL && process.env.DATABASE_URL && process.env.APP_DB_PASSWORD) {
  process.env.APP_DATABASE_URL = appUrlFrom(process.env.DATABASE_URL, process.env.APP_DB_PASSWORD);
}
const config = loadConfig();

// Garde-fou (§7.3) : l'API ne doit jamais tourner avec un rôle qui contourne la RLS.
const check = new pg.Client({ connectionString: config.appDatabaseUrl });
await check.connect();
const role = (await check.query<{ u: string; bypass: boolean }>(`SELECT current_user AS u, rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
if (role.bypass && process.env.ALLOW_RLS_BYPASS !== 'true') {
  await check.end();
  throw new Error(`Le rôle ${role.u} contourne la RLS (superutilisateur ou BYPASSRLS) : utilisez le rôle applicatif jamystock_api.`);
}
// Mono-organisation au MVP : sans TENANT_ID, on prend l'organisation unique de la base.
if (!config.defaultTenantId) {
  const orgs = (await check.query<{ id: string }>('SELECT id FROM organisation LIMIT 2')).rows;
  if (orgs.length === 1) config.defaultTenantId = orgs[0]!.id;
}
await check.end();

const app = await createApp(config);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`API JAMYSTOCK démarrée sur le port ${port}`);

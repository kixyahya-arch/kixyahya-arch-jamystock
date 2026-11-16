import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

/** Dossier des migrations : `apps/api/migrations`, que l'on tourne depuis `src/db` (tsx) ou `dist/src/db` (build). */
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ||
  ['../../migrations', '../../../migrations']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((dir) => existsSync(dir))!;

/** Applique les migrations SQL dans l'ordre, chacune dans sa transaction. */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`migration appliquée : ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Échec de la migration ${file} : ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  migrate(url).then((a) => console.log(a.length ? `${a.length} migration(s) appliquée(s)` : 'Base à jour'));
}

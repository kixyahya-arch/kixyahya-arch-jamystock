import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrate } from './migrate.js';
import { demoPhotoSvg, writeDemoPhoto } from './demo-photos.js';
import { DEMO_PASSWORD, seed } from './seed.js';
import { hashPassword } from '../auth/auth.service.js';

/**
 * Préparation d'une base hébergée, lancée avant chaque déploiement avec l'URL propriétaire (DATABASE_URL) :
 *  1. extensions ;
 *  2. rôles jamystock_app (groupe soumis à la RLS) et jamystock_api (connexion de l'API, mot de passe APP_DB_PASSWORD) ;
 *  3. migrations ;
 *  4. données de démonstration si SEED_DEMO=true et la base est vide ; sinon, réécriture des photos de démonstration
 *     absentes du disque (un hébergeur sans disque persistant efface les fichiers à chaque redémarrage)
 *     et remise du mot de passe des comptes de démo (*.test) à DEMO_PASSWORD, qui peut changer après la seed.
 * Idempotent : se relance sans effet de bord.
 */
export async function provision(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log) {
  const url = env.DATABASE_URL;
  const password = env.APP_DB_PASSWORD;
  if (!url) throw new Error('DATABASE_URL manquant');
  if (!password || password.length < 16) throw new Error('APP_DB_PASSWORD manquant (16 caractères minimum)');

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const ext of ['pg_trgm', 'pgcrypto', 'btree_gist']) await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jamystock_app') THEN CREATE ROLE jamystock_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jamystock_api') THEN CREATE ROLE jamystock_api LOGIN IN ROLE jamystock_app; END IF;
    END $$`);
    // ALTER ROLE n'accepte pas de paramètre lié : le mot de passe est échappé comme littéral SQL
    await c.query(`ALTER ROLE jamystock_api WITH LOGIN PASSWORD ${c.escapeLiteral(password)}`);
    const db = (await c.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
    await c.query(`GRANT CONNECT ON DATABASE ${c.escapeIdentifier(db)} TO jamystock_api`);
    log('Rôles prêts');
  } finally {
    await c.end();
  }

  const applied = await migrate(url, log);
  log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'Schéma à jour');

  if (env.SEED_DEMO === 'true') {
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const n = (await check.query<{ n: number }>('SELECT count(*)::int AS n FROM organisation')).rows[0]!.n;
    await check.end();
    if (n === 0) {
      const r = await seed(url);
      log(`Données de démonstration créées (organisation ${r.tenantId})`);
    } else {
      log('Données déjà présentes : pas de seed');
      const restored = await restoreDemoPhotos(url, env.STORAGE_DIR ?? '.storage');
      if (restored) log(`${restored} photo(s) de démonstration réécrite(s)`);
      log(`Mot de passe des comptes de démonstration appliqué (${await syncDemoPassword(url)} compte(s))`);
    }
  }
}

/** Aligne le mot de passe des comptes de démonstration (emails en .test) sur DEMO_PASSWORD. */
async function syncDemoPassword(url: string): Promise<number> {
  const hash = await hashPassword(DEMO_PASSWORD);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    let n = 0;
    for (const org of (await c.query<{ id: string }>('SELECT id FROM organisation')).rows) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [org.id]);
      const r = await c.query(`UPDATE utilisateur SET mot_de_passe_hash = $1 WHERE email LIKE '%.test'`, [hash]);
      await c.query('COMMIT');
      n += r.rowCount ?? 0;
    }
    return n;
  } finally {
    await c.end();
  }
}

/** Réécrit les illustrations de démonstration (clés `<tenant>/demo/<article>.svg`) manquantes dans le stockage. */
async function restoreDemoPhotos(url: string, storageDir: string): Promise<number> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    let n = 0;
    const orgs = await c.query<{ id: string }>('SELECT id FROM organisation');
    for (const org of orgs.rows) {
      // contexte SYSTEM de l'organisation, comme la seed, pour traverser la RLS (FORCE) appliquée au propriétaire
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [org.id]);
      const { rows } = await c.query<{ cle: string; libelle: string | null; icone: string | null }>(
        `SELECT p.cle_originale AS cle, a.libelle, cat.icone
           FROM photo p JOIN article a ON a.id = p.article_id LEFT JOIN categorie cat ON cat.id = a.categorie_id
          WHERE p.cle_originale LIKE '%/demo/%.svg' ORDER BY p.id`,
      );
      await c.query('COMMIT');
      for (const [i, r] of rows.entries()) {
        if (existsSync(path.resolve(storageDir, r.cle))) continue;
        await writeDemoPhoto(storageDir, r.cle, demoPhotoSvg(r.libelle ?? '', r.icone ?? 'box', i));
        n++;
      }
    }
    return n;
  } finally {
    await c.end();
  }
}

/** URL de connexion de l'API, dérivée de l'URL propriétaire : même hôte et même base, rôle jamystock_api. */
export function appUrlFrom(ownerUrl: string, password: string): string {
  const u = new URL(ownerUrl);
  u.username = 'jamystock_api';
  u.password = password;
  return u.toString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  provision().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}

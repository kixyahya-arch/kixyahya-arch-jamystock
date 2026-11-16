import pg from 'pg';
import type { Role } from '@jamystock/domain';

/** Contexte posé dans chaque transaction pour la RLS (voir migrations/002_rls.sql). */
export interface DbContext {
  tenantId: string;
  userId?: string | null;
  role: Role | 'SYSTEM';
  entrepriseId?: string | null;
}

export type Tx = pg.PoolClient;

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 20 });
    // numeric → number (les surfaces et montants tiennent largement dans un double)
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    // date → chaîne AAAA-MM-JJ (pas de décalage de fuseau)
    pg.types.setTypeParser(1082, (v) => v);
  }

  /** Exécute fn dans une transaction avec le contexte RLS. */
  async tx<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.role', $3, true), set_config('app.entreprise_id', $4, true)`,
        [ctx.tenantId, ctx.userId ?? '', ctx.role, ctx.entrepriseId ?? ''],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

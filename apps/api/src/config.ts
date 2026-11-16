export interface AppConfig {
  appDatabaseUrl: string;
  jwtSecret: string;
  mfaEnforce: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** Organisation exploitante par défaut (mono-tenant au MVP, multi-tenant prévu : O12). */
  defaultTenantId: string | null;
  /** Répertoire de stockage local des fichiers (dev) */
  storageDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appDatabaseUrl = env.APP_DATABASE_URL ?? env.DATABASE_URL;
  if (!appDatabaseUrl) throw new Error('APP_DATABASE_URL manquant');
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET doit faire au moins 32 caractères');
  return {
    appDatabaseUrl,
    jwtSecret,
    mfaEnforce: env.MFA_ENFORCE === 'true',
    accessTokenTtlSeconds: 15 * 60, // §7.3 : jetons d'accès courts (15 min)
    refreshTokenTtlDays: 30,
    defaultTenantId: env.TENANT_ID ?? null,
    storageDir: env.STORAGE_DIR ?? '.storage',
  };
}

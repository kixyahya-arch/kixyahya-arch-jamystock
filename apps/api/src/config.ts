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
  /** Builds des applis web à servir par l'API (mise en ligne sur une seule adresse) */
  frontends: { client?: string; terrain?: string; admin?: string };
  /** Tâches de facturation planifiées (instantanés, brouillons, émission) : actives en production, ou BILLING_SCHEDULER=on */
  billingScheduler: boolean;
  /** Adresse publique de l'Espace Client, pour les liens des e-mails (Render la fournit dans RENDER_EXTERNAL_URL). */
  publicUrl: string;
  /** Envoi des e-mails (§6.3) : Brevo si une clé est fournie, sinon les messages restent consultables dans le Back-Office. */
  mail: { brevoApiKey?: string; fromEmail: string; fromName: string; worker: boolean };
  /** ADM-04 : paiement par Stripe (carte, prélèvement SEPA). Sans clé, seul le virement est proposé. */
  stripe: { secretKey?: string; webhookSecret?: string; apiBase: string };
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
    frontends: { client: env.CLIENT_DIST || undefined, terrain: env.TERRAIN_DIST || undefined, admin: env.ADMIN_DIST || undefined },
    billingScheduler: env.BILLING_SCHEDULER ? env.BILLING_SCHEDULER === 'on' : env.NODE_ENV === 'production' || env.RENDER === 'true',
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    mail: {
      brevoApiKey: env.BREVO_API_KEY || undefined,
      fromEmail: env.MAIL_FROM || 'no-reply@jamystock.fr',
      fromName: env.MAIL_FROM_NAME || 'JAMYSTOCK',
      worker: env.MAIL_WORKER ? env.MAIL_WORKER === 'on' : env.NODE_ENV === 'production' || env.RENDER === 'true',
    },
    stripe: { secretKey: env.STRIPE_SECRET_KEY || undefined, webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined, apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com' },
  };
}

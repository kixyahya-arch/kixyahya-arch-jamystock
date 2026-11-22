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
  /** SUI-02 : géocodage des adresses (Base Adresse Nationale) pour l'heure d'arrivée estimée ; actif en production. */
  geocoder: { mode: 'ban' | 'off'; baseUrl: string };
  /** CLI-01 : vérification des SIRET (API Recherche d'entreprises, répertoire Sirene). */
  sirene: { mode: 'on' | 'off'; baseUrl: string };
  /** FLX-05 : fond de carte du Back-Office et de la page de suivi (tuiles XYZ). */
  mapTilesUrl: string;
  /** Reprise de données : autorise le téléchargement de photos depuis une adresse locale ou privée (tests seulement). */
  reprisePhotosLocal: boolean;
  /**
   * Visuels d'aménagement des packs générés par Higgsfield (api.higgsfield.ai). Sans clé, la génération est
   * désactivée et seule l'image ajoutée à la main est proposée. Les plafonds protègent le solde du compte.
   */
  higgsfield: {
    keyId?: string;
    keySecret?: string;
    baseUrl: string;
    /** chemin du modèle, par ex. higgsfield-ai/soul/standard */
    model: string;
    /** champ du modèle qui reçoit les photos des meubles (image_url, image_urls…) ; vide : texte seul */
    imageField?: string;
    /** paramètres ajoutés tels quels au corps de la requête (JSON), par ex. {"resolution":"2K"} */
    params: Record<string, unknown>;
    aspectRatio: string;
    maxParClientParMois: number;
    maxParMois: number;
    pollMs: number;
    timeoutMs: number;
  };
}

function jsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const intOr = (raw: string | undefined, d: number) => (raw && /^\d+$/.test(raw) ? Number(raw) : d);

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
    sirene: {
      mode: (env.SIRENE ? env.SIRENE : env.NODE_ENV === 'production' || env.RENDER === 'true' ? 'on' : 'off') === 'on' ? 'on' : 'off',
      baseUrl: (env.SIRENE_URL || 'https://recherche-entreprises.api.gouv.fr').replace(/\/+$/, ''),
    },
    geocoder: {
      mode: (env.GEOCODER ? env.GEOCODER : env.NODE_ENV === 'production' || env.RENDER === 'true' ? 'ban' : 'off') === 'ban' ? 'ban' : 'off',
      baseUrl: (env.GEOCODER_URL || 'https://api-adresse.data.gouv.fr').replace(/\/+$/, ''),
    },
    mapTilesUrl: env.MAP_TILES_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    reprisePhotosLocal: env.REPRISE_PHOTOS_LOCAL === 'on',
    higgsfield: {
      keyId: env.HIGGSFIELD_API_KEY_ID || undefined,
      keySecret: env.HIGGSFIELD_API_KEY_SECRET || undefined,
      baseUrl: (env.HIGGSFIELD_URL || 'https://api.higgsfield.ai').replace(/\/+$/, ''),
      model: (env.HIGGSFIELD_MODEL || 'higgsfield-ai/soul/standard').replace(/^\/+|\/+$/g, ''),
      imageField: env.HIGGSFIELD_IMAGE_FIELD || undefined,
      params: jsonObject(env.HIGGSFIELD_PARAMS),
      aspectRatio: env.HIGGSFIELD_ASPECT_RATIO || '4:3',
      maxParClientParMois: intOr(env.HIGGSFIELD_MAX_PAR_CLIENT, 20),
      maxParMois: intOr(env.HIGGSFIELD_MAX_PAR_MOIS, 100),
      pollMs: intOr(env.HIGGSFIELD_POLL_MS, 2000),
      timeoutMs: intOr(env.HIGGSFIELD_TIMEOUT_MS, 5 * 60_000),
    },
  };
}

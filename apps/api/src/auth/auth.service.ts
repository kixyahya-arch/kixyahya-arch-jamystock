import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import { requiresMfa, uuidv7, type Role } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { BusinessError } from '../common/errors.js';
import { verifyTotp } from './totp.js';

export interface AuthUser {
  id: string;
  tenantId: string;
  role: Role;
  entrepriseId: string | null;
  sessionVersion: number;
  /** CLI-02 : session ouverte par un Super Admin « en tant que » ce client (lecture seule). */
  impersonation?: { by: string; sv: number; exp: number };
}

/** Durée d'une session « en tant que » (CLI-02). */
export const IMPERSONATION_TTL_SECONDS = 30 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const unauthorized = (msg = 'Identifiants invalides') => new BusinessError(401, 'UNAUTHORIZED', msg);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Paramètres argon2id (OWASP : m = 19 Mio, t = 2, p = 1). */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

interface UserRow {
  id: string;
  tenant_id: string;
  role: Role;
  entreprise_id: string | null;
  mot_de_passe_hash: string | null;
  mfa_secret: string | null;
  statut: string;
  session_version: number;
}

@Injectable()
export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async login(input: { tenantId: string; email: string; password: string; mfaCode?: string; deviceId?: string }): Promise<TokenPair> {
    const user = await this.db.tx({ tenantId: input.tenantId, role: 'SYSTEM' }, async (tx) => {
      const r = await tx.query<UserRow>(
        `SELECT id, tenant_id, role, entreprise_id, mot_de_passe_hash, mfa_secret, statut, session_version
           FROM utilisateur WHERE tenant_id = $1 AND lower(email) = lower($2)`,
        [input.tenantId, input.email],
      );
      return r.rows[0];
    });
    // on vérifie toujours un hash pour ne pas révéler l'existence du compte par le temps de réponse
    const ok = await verify(user?.mot_de_passe_hash ?? DUMMY_HASH, input.password).catch(() => false);
    if (!user || !ok || user.statut !== 'ACTIF') throw unauthorized();

    if (user.mfa_secret) {
      if (!input.mfaCode) throw new BusinessError(401, 'MFA_REQUIRED', 'Code MFA requis');
      if (!verifyTotp(user.mfa_secret, input.mfaCode)) throw unauthorized('Code MFA invalide');
    } else if (this.config.mfaEnforce && requiresMfa(user.role)) {
      throw new BusinessError(403, 'MFA_SETUP_REQUIRED', 'Le MFA doit être configuré pour ce rôle');
    }

    await this.db.tx({ tenantId: user.tenant_id, role: 'SYSTEM' }, (tx) =>
      tx.query('UPDATE utilisateur SET derniere_connexion = now() WHERE id = $1', [user.id]),
    );
    return this.issue(toAuthUser(user), uuidv7(), input.deviceId);
  }

  /** Jeton de rafraîchissement rotatif : réutiliser un jeton déjà consommé révoque toute la famille. */
  async refresh(tenantId: string, refreshToken: string): Promise<TokenPair> {
    const tokenHash = sha256(refreshToken);
    const result = await this.db.tx({ tenantId, role: 'SYSTEM' }, async (tx) => {
      const r = await tx.query<{ id: string; famille: string; revoque_le: Date | null; expire_le: Date; appareil_id: string | null } & UserRow>(
        `SELECT rt.id, rt.famille, rt.revoque_le, rt.expire_le, rt.appareil_id,
                u.id AS user_id, u.tenant_id, u.role, u.entreprise_id, u.statut, u.session_version
           FROM refresh_token rt JOIN utilisateur u ON u.id = rt.utilisateur_id
          WHERE rt.token_hash = $1 AND u.tenant_id = $2 FOR UPDATE OF rt`,
        [tokenHash, tenantId],
      );
      const row = r.rows[0] as (typeof r.rows)[number] & { user_id: string } | undefined;
      if (!row) return null;
      if (row.revoque_le) {
        await tx.query('UPDATE refresh_token SET revoque_le = coalesce(revoque_le, now()) WHERE famille = $1', [row.famille]);
        return 'REUSED' as const;
      }
      if (row.expire_le < new Date() || row.statut !== 'ACTIF') return null;
      await tx.query('UPDATE refresh_token SET revoque_le = now() WHERE id = $1', [row.id]);
      return { user: toAuthUser({ ...row, id: row.user_id }), famille: row.famille, deviceId: row.appareil_id ?? undefined };
    });
    if (result === 'REUSED') throw unauthorized('Jeton de rafraîchissement réutilisé : session révoquée');
    if (!result) throw unauthorized('Jeton de rafraîchissement invalide');
    return this.issue(result.user, result.famille, result.deviceId);
  }

  async logout(tenantId: string, refreshToken: string): Promise<void> {
    await this.db.tx({ tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query('UPDATE refresh_token SET revoque_le = now() WHERE famille = (SELECT famille FROM refresh_token WHERE token_hash = $1)', [
        sha256(refreshToken),
      ]),
    );
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      const imp = payload.imp as { by: string; sv: number } | undefined;
      return {
        id: payload.sub as string,
        tenantId: payload.tid as string,
        role: payload.role as Role,
        entrepriseId: (payload.eid as string | null) ?? null,
        sessionVersion: payload.sv as number,
        ...(imp ? { impersonation: { by: imp.by, sv: imp.sv, exp: payload.exp as number } } : {}),
      };
    } catch {
      throw unauthorized('Jeton invalide ou expiré');
    }
  }

  /** ADM-03 : la désactivation coupe immédiatement les sessions (statut + version de session vérifiés à chaque requête). */
  async assertSessionActive(user: AuthUser): Promise<void> {
    const r = await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query<{ statut: string; session_version: number }>('SELECT statut, session_version FROM utilisateur WHERE id = $1', [user.id]),
    );
    const row = r.rows[0];
    if (!row || row.statut !== 'ACTIF' || row.session_version !== user.sessionVersion) throw unauthorized('Session révoquée');
    if (user.impersonation) {
      // la session « en tant que » tombe aussi si le Super Admin qui l'a ouverte est déconnecté ou désactivé
      const a = await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) =>
        tx.query<{ statut: string; session_version: number; role: string }>('SELECT statut, session_version, role FROM utilisateur WHERE id = $1', [user.impersonation!.by]),
      );
      const admin = a.rows[0];
      if (!admin || admin.statut !== 'ACTIF' || admin.role !== 'SUPER_ADMIN' || admin.session_version !== user.impersonation.sv) throw unauthorized('Session de support révoquée');
    }
  }

  /**
   * CLI-02 : jeton d'accès « en tant que » un utilisateur client, pour le support. Court (30 min), sans jeton de
   * rafraîchissement, et limité à la lecture par la garde. L'appelant trace l'ouverture dans l'audit.
   */
  async impersonate(admin: AuthUser, target: AuthUser): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await new SignJWT({ tid: target.tenantId, role: target.role, eid: target.entrepriseId, sv: target.sessionVersion, imp: { by: admin.id, sv: admin.sessionVersion } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(target.id)
      .setIssuedAt()
      .setExpirationTime(`${IMPERSONATION_TTL_SECONDS}s`)
      .sign(this.key);
    return { accessToken, expiresIn: IMPERSONATION_TTL_SECONDS };
  }

  private async issue(user: AuthUser, famille: string, deviceId?: string): Promise<TokenPair> {
    const accessToken = await new SignJWT({ tid: user.tenantId, role: user.role, eid: user.entrepriseId, sv: user.sessionVersion })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .sign(this.key);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query(
        `INSERT INTO refresh_token (id, utilisateur_id, token_hash, famille, appareil_id, expire_le)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
        [uuidv7(), user.id, sha256(refreshToken), famille, deviceId ?? null, this.config.refreshTokenTtlDays],
      ),
    );
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }
}

export function toAuthUser(row: Pick<UserRow, 'id' | 'tenant_id' | 'role' | 'entreprise_id' | 'session_version'>): AuthUser {
  return { id: row.id, tenantId: row.tenant_id, role: row.role, entrepriseId: row.entreprise_id, sessionVersion: row.session_version };
}

// hash d'un mot de passe aléatoire, utilisé quand le compte n'existe pas
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Dn+ZqSOG3JDBwTcqQvSKgMe4+2Br3q8vXBRcHkN8tC8';

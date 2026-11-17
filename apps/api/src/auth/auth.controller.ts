import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { BusinessError } from '../common/errors.js';

const LoginBody = z.object({
  tenantId: z.string().uuid().optional(),
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().optional(),
  deviceId: z.string().max(200).optional(),
});
const RefreshBody = z.object({ tenantId: z.string().uuid().optional(), refreshToken: z.string().min(10) });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  private tenant(id?: string): string {
    const t = id ?? this.config.defaultTenantId;
    if (!t) throw new BusinessError(400, 'TENANT_REQUIRED', 'Organisation non précisée');
    return t;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    const b = LoginBody.parse(body);
    return this.auth.login({ ...b, tenantId: this.tenant(b.tenantId) });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    const b = RefreshBody.parse(body);
    return this.auth.refresh(this.tenant(b.tenantId), b.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    const b = RefreshBody.parse(body);
    await this.auth.logout(this.tenant(b.tenantId), b.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const me = await this.db.tx({ tenantId: user.tenantId, userId: user.id, role: user.role, entrepriseId: user.entrepriseId }, async (tx) => {
      const r = await tx.query(
        `SELECT u.id, u.email, u.nom, u.role, u.entreprise_id AS "entrepriseId", e.nom AS "entrepriseNom", e.type AS "entrepriseType",
                coalesce((SELECT json_agg(json_build_object('projetId', ap.projet_id, 'peutCommander', ap.peut_commander))
                            FROM acces_projet ap WHERE ap.utilisateur_id = u.id), '[]') AS projets
           FROM utilisateur u LEFT JOIN entreprise e ON e.id = u.entreprise_id WHERE u.id = $1`,
        [user.id],
      );
      return r.rows[0];
    });
    // CLI-02 : l'Espace Client affiche un bandeau « mode support » ; le nom du Super Admin se lit en contexte système
    const imp = user.impersonation;
    const support = imp
      ? {
          par: (await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) => tx.query<{ nom: string }>('SELECT nom FROM utilisateur WHERE id = $1', [imp.by]))).rows[0]?.nom ?? null,
          expireLe: new Date(imp.exp * 1000).toISOString(),
        }
      : null;
    return { ...me, support };
  }
}

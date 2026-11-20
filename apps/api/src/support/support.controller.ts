import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Role } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { AuthService, toAuthUser, type AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

const Body_ = z.object({
  entrepriseId: z.string().uuid(),
  utilisateurId: z.string().uuid().optional(),
  motif: z.string().trim().min(3, 'Motif obligatoire (3 caractères minimum)').max(300),
});

/**
 * CLI-02 : le Super Admin ouvre l'Espace Client « en tant que » un utilisateur du client pour reproduire ce qu'il voit.
 * Lecture seule (la garde refuse toute écriture), 30 minutes, motif obligatoire, tracé dans l'audit.
 */
@Controller('bo/support')
export class SupportController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('impersonate')
  @HttpCode(200)
  @RequirePermission('client.manage')
  async impersonate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    if (user.impersonation) throw forbidden('Déjà en mode support');
    const b = Body_.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const rows = await tx.query<{ id: string; tenant_id: string; role: Role; entreprise_id: string | null; session_version: number; nom: string; email: string; statut: string; entreprise: string }>(
        `SELECT u.id, u.tenant_id, u.role, u.entreprise_id, u.session_version, u.nom, u.email, u.statut, e.nom AS entreprise
           FROM utilisateur u JOIN entreprise e ON e.id = u.entreprise_id
          WHERE u.entreprise_id = $1 AND ($2::uuid IS NULL OR u.id = $2)
          ORDER BY (u.statut = 'ACTIF') DESC, (u.role IN ('B2B_ADMIN','B2C')) DESC, u.nom`,
        [b.entrepriseId, b.utilisateurId ?? null],
      );
      const target = rows.rows[0];
      if (!target) throw notFound(b.utilisateurId ? 'Utilisateur' : 'Utilisateur du client');
      if (target.statut !== 'ACTIF') throw conflict('INACTIF', 'Cet utilisateur n’a pas d’accès actif : il n’y a rien à reproduire de son côté');
      const t = await this.auth.impersonate(user, toAuthUser(target));
      await this.audit.record(tx, user, {
        action: 'CONNEXION_EN_TANT_QUE',
        objet: 'utilisateur',
        objetId: target.id,
        entrepriseId: b.entrepriseId,
        apres: { utilisateur: target.email, lectureSeule: true, dureeMinutes: t.expiresIn / 60 },
        motif: b.motif,
      });
      return {
        ...t,
        utilisateur: { id: target.id, nom: target.nom, email: target.email, role: target.role, entreprise: target.entreprise },
        // le jeton passe dans l'ancre : il n'est jamais envoyé au serveur dans l'URL ni gardé dans les journaux d'accès
        url: `/#/support/${t.accessToken}`,
      };
    });
  }
}

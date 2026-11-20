import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { notFound } from '../common/errors.js';
import { NotificationsService } from './notifications.service.js';

/** Back-Office : suivi des e-mails envoyés (§6.3), aperçu et envoi immédiat de la file. */
@Controller('bo/emails')
export class NotificationsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @RequirePermission('client.manage')
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    const f = z.object({ statut: z.enum(['EN_ATTENTE', 'ENVOYEE', 'ECHEC', 'IGNOREE']).optional(), q: z.string().trim().max(100).optional() }).parse(q);
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT n.id, n.modele, n.statut, n.objet, n.fournisseur, n.erreur, n.tentatives, n.created_at AS "creeLe", n.envoyee_le AS "envoyeeLe",
                coalesce(n.destinataire_adresse, u.email) AS destinataire, u.nom AS "destinataireNom", e.nom AS entreprise
           FROM notification n LEFT JOIN utilisateur u ON u.id = n.destinataire_id LEFT JOIN entreprise e ON e.id = u.entreprise_id
          WHERE n.canal = 'EMAIL' AND ($1::text IS NULL OR n.statut = $1)
            AND ($2::text IS NULL OR coalesce(n.destinataire_adresse, u.email) ILIKE '%' || $2 || '%' OR n.objet ILIKE '%' || $2 || '%' OR e.nom ILIKE '%' || $2 || '%')
          ORDER BY n.created_at DESC LIMIT 200`,
        [f.statut ?? null, f.q || null],
      );
      const counts = await tx.query(`SELECT statut, count(*)::int AS n FROM notification WHERE canal = 'EMAIL' GROUP BY statut`);
      return { items: r.rows, compteurs: Object.fromEntries(counts.rows.map((c) => [c.statut, c.n])), fournisseur: this.notifications.provider };
    });
  }

  @Get(':id')
  @RequirePermission('client.manage')
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<{ modele: string; variables: Record<string, unknown>; nom: string | null }>(
        `SELECT n.modele, n.variables, u.nom FROM notification n LEFT JOIN utilisateur u ON u.id = n.destinataire_id WHERE n.id = $1 AND n.canal = 'EMAIL'`,
        [z.string().uuid().parse(id)],
      );
      const n = r.rows[0];
      if (!n) throw notFound('E-mail');
      const mail = this.notifications.preview(n.modele, n.variables, n.nom);
      if (!mail) throw notFound('Modèle');
      return mail;
    });
  }

  @Post('flush')
  @HttpCode(200)
  @RequirePermission('client.manage')
  flush(@CurrentUser() user: AuthUser) {
    return this.notifications.flush(user.tenantId);
  }
}

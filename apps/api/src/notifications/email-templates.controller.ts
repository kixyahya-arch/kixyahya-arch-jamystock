import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { uuidv7 } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from './notifications.service.js';
import { defaultTemplate, EDITABLE, placeholders, type EmailOverride } from './templates.js';

const Text = z.object({
  sujet: z.string().trim().min(3).max(200),
  corps: z.string().trim().min(3).max(4000),
  bouton: z.string().trim().max(60).nullish(),
});

/**
 * §6.3 : l'exploitant adapte le texte des e-mails (sujet, paragraphes, bouton) avec des repères {{numero}}…
 * Le lien du bouton, la mise en page et l'en-tête restent fixes ; « Revenir au texte d'origine » efface la version.
 */
@Controller('bo/email-templates')
export class EmailTemplatesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private find(modele: string) {
    const e = EDITABLE.find((x) => x.modele === modele);
    if (!e) throw notFound('Modèle');
    return e;
  }

  @Get()
  @RequirePermission('client.manage')
  list(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const custom = (await tx.query<{ modele: string; updatedAt: Date; par: string | null }>(
        `SELECT m.modele, m.updated_at AS "updatedAt", u.nom AS par FROM modele_email m LEFT JOIN utilisateur u ON u.id = m.updated_by`,
      )).rows;
      return EDITABLE.map((e) => {
        const c = custom.find((x) => x.modele === e.modele);
        return { modele: e.modele, libelle: e.libelle, sujet: defaultTemplate(e.modele)?.sujet ?? '', personnalise: !!c, modifieLe: c?.updatedAt ?? null, modifiePar: c?.par ?? null };
      });
    });
  }

  @Get(':modele')
  @RequirePermission('client.manage')
  get(@CurrentUser() user: AuthUser, @Param('modele') modele: string) {
    const e = this.find(modele);
    return this.db.tx(ctxOf(user), async (tx) => {
      const actuel = (await this.notifications.overrides(tx)).get(e.modele) ?? null;
      return {
        modele: e.modele,
        libelle: e.libelle,
        reperes: placeholders(e.modele),
        defaut: defaultTemplate(e.modele),
        actuel,
        apercu: this.notifications.preview(e.modele, e.exemple, 'Camille Martin', actuel),
      };
    });
  }

  /** Aperçu d'un texte en cours d'édition, avec les variables d'exemple. */
  @Post(':modele/apercu')
  @HttpCode(200)
  @RequirePermission('client.manage')
  preview(@Param('modele') modele: string, @Body() body: unknown) {
    const e = this.find(modele);
    const t = this.check(e.modele, Text.parse(body));
    return this.notifications.preview(e.modele, e.exemple, 'Camille Martin', t);
  }

  @Put(':modele')
  @RequirePermission('client.manage')
  save(@CurrentUser() user: AuthUser, @Param('modele') modele: string, @Body() body: unknown) {
    const e = this.find(modele);
    const t = this.check(e.modele, Text.parse(body));
    return this.db.tx(ctxOf(user), async (tx) => {
      await tx.query(
        `INSERT INTO modele_email (id, tenant_id, modele, sujet, corps, bouton, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, modele) DO UPDATE SET sujet = EXCLUDED.sujet, corps = EXCLUDED.corps, bouton = EXCLUDED.bouton, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [uuidv7(), user.tenantId, e.modele, t.sujet, t.corps, t.bouton, user.id],
      );
      await this.audit.record(tx, user, { action: 'MODELE_EMAIL_MODIFIE', objet: 'modele_email', objetId: null, apres: { modele: e.modele, ...t } });
      return { modele: e.modele, personnalise: true };
    });
  }

  @Delete(':modele')
  @RequirePermission('client.manage')
  reset(@CurrentUser() user: AuthUser, @Param('modele') modele: string) {
    const e = this.find(modele);
    return this.db.tx(ctxOf(user), async (tx) => {
      await tx.query('DELETE FROM modele_email WHERE modele = $1', [e.modele]);
      await this.audit.record(tx, user, { action: 'MODELE_EMAIL_REINITIALISE', objet: 'modele_email', objetId: null, apres: { modele: e.modele } });
      return { modele: e.modele, personnalise: false };
    });
  }

  /** Un repère inconnu laisserait un trou dans l'e-mail envoyé : on le refuse à l'enregistrement. */
  private check(modele: string, t: z.infer<typeof Text>): EmailOverride {
    const known = new Set(placeholders(modele));
    const used = [...`${t.sujet} ${t.corps} ${t.bouton ?? ''}`.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map((m) => m[1]!);
    const unknown = [...new Set(used.filter((k) => !known.has(k)))];
    if (unknown.length) throw unprocessable('REPERE_INCONNU', `Repère inconnu : ${unknown.map((k) => `{{${k}}}`).join(', ')}. Repères possibles : ${[...known].map((k) => `{{${k}}}`).join(', ')}`);
    return { sujet: t.sujet, corps: t.corps, bouton: t.bouton || null };
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { AuthService, hashPassword, type AuthUser } from '../auth/auth.service.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import { ctxOf } from '../common/context.js';
import { BusinessError, conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OPTIONAL_EVENTS } from '../notifications/templates.js';
import { createInvitation, tokenHash } from './invitations.js';

const uuid = z.string().uuid();
const ClientRole = z.enum(['B2B_ADMIN', 'B2B_USER']);
const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  nom: z.string().trim().min(2).max(120),
  role: ClientRole,
  projets: z.array(uuid).max(500).default([]),
  peutCommanderSeul: z.boolean().default(true),
});
const UpdateBody = z.object({
  nom: z.string().trim().min(2).max(120).optional(),
  role: ClientRole.optional(),
  projets: z.array(uuid).max(500).optional(),
  peutCommanderSeul: z.boolean().optional(),
});
/** Mot de passe : 10 caractères au moins, dont une lettre et un chiffre (§7.3). */
const Password = z
  .string()
  .min(10, 'Le mot de passe doit faire au moins 10 caractères')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Le mot de passe doit contenir au moins une lettre et un chiffre');

interface UserRow {
  id: string;
  nom: string;
  email: string;
  role: 'B2B_ADMIN' | 'B2B_USER';
  statut: 'INVITE' | 'ACTIF' | 'DESACTIVE';
  mot_de_passe_hash: string | null;
}

/**
 * ADM-03 : un administrateur client invite, modifie et désactive les utilisateurs de son entreprise et leur attribue
 * des projets. La désactivation coupe immédiatement les sessions (statut et version de session vérifiés à chaque requête).
 * Aussi : acceptation d'une invitation (public) et préférences de notification de chacun (§6.3).
 */
@Controller()
export class AccountsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private companyAdmin(user: AuthUser) {
    if (user.role !== 'B2B_ADMIN' || !user.entrepriseId) throw forbidden('Réservé aux administrateurs d’un compte entreprise');
  }

  private tenant(): string {
    const t = this.config.defaultTenantId;
    if (!t) throw new BusinessError(400, 'TENANT_REQUIRED', 'Organisation non précisée');
    return t;
  }

  // ===========================================================================================================
  // Utilisateurs de l'entreprise (B2B Admin)
  // ===========================================================================================================

  @Get('me/users')
  @RequirePermission('company.users.manage')
  list(@CurrentUser() user: AuthUser) {
    this.companyAdmin(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const users = await tx.query(
        `SELECT u.id, u.nom, u.email, u.role, u.statut, u.peut_commander_seul AS "peutCommanderSeul", u.derniere_connexion AS "derniereConnexion",
                u.created_at AS "creeLe",
                coalesce((SELECT array_agg(ap.projet_id) FROM acces_projet ap WHERE ap.utilisateur_id = u.id), '{}') AS projets,
                (SELECT json_build_object('expireLe', i.expire_le, 'expiree', i.expire_le < now())
                   FROM invitation i WHERE i.utilisateur_id = u.id AND i.acceptee_le IS NULL AND i.revoquee_le IS NULL
                  ORDER BY i.created_at DESC LIMIT 1) AS invitation
           FROM utilisateur u WHERE u.entreprise_id = $1
          ORDER BY u.statut = 'DESACTIVE', u.role, u.nom`,
        [user.entrepriseId],
      );
      const projets = await tx.query(`SELECT id, nom, statut FROM projet WHERE entreprise_id = $1 ORDER BY statut <> 'ACTIF', nom`, [user.entrepriseId]);
      return { items: users.rows, projets: projets.rows, moi: user.id, envoiEmails: this.notifications.provider === 'BREVO' };
    });
  }

  @Post('me/users')
  @RequirePermission('company.users.manage')
  invite(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.companyAdmin(user);
    const b = InviteBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const exists = await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (sys) =>
        sys.query('SELECT 1 FROM utilisateur WHERE tenant_id = $1 AND lower(email) = $2', [user.tenantId, b.email]),
      );
      if (exists.rowCount) throw conflict('EMAIL_EXISTANT', 'Cette adresse a déjà un compte JAMYSTOCK');
      await this.assertProjects(tx, user, b.projets);
      const id = uuidv7();
      await tx.query(
        `INSERT INTO utilisateur (id, tenant_id, entreprise_id, email, nom, role, statut, peut_commander_seul, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'INVITE',$7,$8)`,
        [id, user.tenantId, user.entrepriseId, b.email, b.nom, b.role, b.peutCommanderSeul, user.id],
      );
      await this.setProjects(tx, id, b.projets);
      const inv = await this.sendInvitation(tx, user, id);
      await this.audit.record(tx, user, { action: 'UTILISATEUR_INVITE', objet: 'utilisateur', objetId: id, entrepriseId: user.entrepriseId, apres: b });
      return { id, expireLe: inv.expireLe, ...(this.notifications.provider === 'JOURNAL' ? { lien: inv.lien } : {}) };
    });
  }

  @Put('me/users/:id')
  @RequirePermission('company.users.manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    this.companyAdmin(user);
    const b = UpdateBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const u = await this.lockUser(tx, user, uuid.parse(id));
      if (b.role && b.role !== u.role && u.role === 'B2B_ADMIN') await this.assertOtherAdmin(tx, user, u.id, 'Il faut garder au moins un administrateur actif');
      if (b.projets) await this.assertProjects(tx, user, b.projets);
      await tx.query(
        `UPDATE utilisateur SET nom = coalesce($2, nom), role = coalesce($3::role_utilisateur, role), peut_commander_seul = coalesce($4, peut_commander_seul),
                session_version = session_version + CASE WHEN $3::role_utilisateur IS NOT NULL AND $3::role_utilisateur <> role THEN 1 ELSE 0 END,
                updated_at = now()
          WHERE id = $1`,
        [u.id, b.nom ?? null, b.role ?? null, b.peutCommanderSeul ?? null],
      );
      if (b.projets) await this.setProjects(tx, u.id, b.projets);
      await this.audit.record(tx, user, { action: 'UTILISATEUR_MODIFIE', objet: 'utilisateur', objetId: u.id, entrepriseId: user.entrepriseId, avant: { nom: u.nom, role: u.role }, apres: b });
      return { ok: true };
    });
  }

  @Post('me/users/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('company.users.manage')
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.companyAdmin(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const u = await this.lockUser(tx, user, uuid.parse(id));
      if (u.id === user.id) throw conflict('SOI_MEME', 'Vous ne pouvez pas désactiver votre propre accès');
      if (u.statut === 'DESACTIVE') return { ok: true };
      // désactivation immédiate : le jeton d'accès en cours est refusé dès la requête suivante, les sessions sont révoquées
      await tx.query(`UPDATE utilisateur SET statut = 'DESACTIVE', session_version = session_version + 1, updated_at = now() WHERE id = $1`, [u.id]);
      await tx.query(`UPDATE refresh_token SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL`, [u.id]);
      await tx.query(`UPDATE invitation SET revoquee_le = now() WHERE utilisateur_id = $1 AND acceptee_le IS NULL AND revoquee_le IS NULL`, [u.id]);
      await this.audit.record(tx, user, { action: 'UTILISATEUR_DESACTIVE', objet: 'utilisateur', objetId: u.id, entrepriseId: user.entrepriseId, avant: { statut: u.statut } });
      return { ok: true };
    });
  }

  @Post('me/users/:id/reactivate')
  @HttpCode(200)
  @RequirePermission('company.users.manage')
  reactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.companyAdmin(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const u = await this.lockUser(tx, user, uuid.parse(id));
      if (u.statut !== 'DESACTIVE') return { ok: true };
      // sans mot de passe (invitation jamais acceptée), on repart sur une invitation
      const statut = u.mot_de_passe_hash ? 'ACTIF' : 'INVITE';
      await tx.query(`UPDATE utilisateur SET statut = $2, updated_at = now() WHERE id = $1`, [u.id, statut]);
      const inv = statut === 'INVITE' ? await this.sendInvitation(tx, user, u.id) : null;
      await this.audit.record(tx, user, { action: 'UTILISATEUR_REACTIVE', objet: 'utilisateur', objetId: u.id, entrepriseId: user.entrepriseId, apres: { statut } });
      return { ok: true, statut, ...(inv && this.notifications.provider === 'JOURNAL' ? { lien: inv.lien } : {}) };
    });
  }

  @Post('me/users/:id/invite')
  @HttpCode(200)
  @RequirePermission('company.users.manage')
  resend(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.companyAdmin(user);
    return this.db.tx(ctxOf(user), async (tx) => {
      const u = await this.lockUser(tx, user, uuid.parse(id));
      if (u.statut !== 'INVITE') throw conflict('DEJA_ACTIF', 'Cet utilisateur a déjà activé son accès');
      const inv = await this.sendInvitation(tx, user, u.id);
      await this.audit.record(tx, user, { action: 'INVITATION_RENVOYEE', objet: 'utilisateur', objetId: u.id, entrepriseId: user.entrepriseId });
      return { expireLe: inv.expireLe, ...(this.notifications.provider === 'JOURNAL' ? { lien: inv.lien } : {}) };
    });
  }

  private async sendInvitation(tx: Tx, user: AuthUser, utilisateurId: string) {
    const me = (await tx.query<{ nom: string }>('SELECT nom FROM utilisateur WHERE id = $1', [user.id])).rows[0];
    return createInvitation(tx, { tenantId: user.tenantId, utilisateurId, entrepriseId: user.entrepriseId, createdBy: user.id, invitePar: me?.nom ?? 'Votre administrateur', publicUrl: this.config.publicUrl });
  }

  private async lockUser(tx: Tx, user: AuthUser, id: string): Promise<UserRow> {
    const r = await tx.query<UserRow>(
      `SELECT id, nom, email, role, statut, mot_de_passe_hash FROM utilisateur WHERE id = $1 AND entreprise_id = $2 FOR UPDATE`,
      [id, user.entrepriseId],
    );
    if (!r.rows[0]) throw notFound('Utilisateur');
    return r.rows[0];
  }

  private async assertOtherAdmin(tx: Tx, user: AuthUser, exceptId: string, msg: string) {
    const r = await tx.query(`SELECT 1 FROM utilisateur WHERE entreprise_id = $1 AND role = 'B2B_ADMIN' AND statut = 'ACTIF' AND id <> $2 LIMIT 1`, [user.entrepriseId, exceptId]);
    if (!r.rowCount) throw conflict('DERNIER_ADMIN', msg);
  }

  private async assertProjects(tx: Tx, user: AuthUser, ids: string[]) {
    if (!ids.length) return;
    const r = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM projet WHERE entreprise_id = $1 AND id = ANY($2::uuid[])', [user.entrepriseId, ids]);
    if (r.rows[0]!.n !== new Set(ids).size) throw unprocessable('PROJET_INCONNU', 'Un des projets n’appartient pas à votre entreprise');
  }

  private async setProjects(tx: Tx, utilisateurId: string, ids: string[]) {
    await tx.query('DELETE FROM acces_projet WHERE utilisateur_id = $1 AND NOT (projet_id = ANY($2::uuid[]))', [utilisateurId, ids]);
    for (const p of new Set(ids)) {
      await tx.query('INSERT INTO acces_projet (utilisateur_id, projet_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [utilisateurId, p]);
    }
  }

  // ===========================================================================================================
  // Invitation (public)
  // ===========================================================================================================

  @Public()
  @Get('auth/invitation/:token')
  async invitation(@Param('token') token: string) {
    const inv = await this.findInvitation(token);
    return { email: inv.email, nom: inv.nom, entreprise: inv.entreprise };
  }

  @Public()
  @Post('auth/invitation/accept')
  @HttpCode(200)
  async accept(@Body() body: unknown) {
    const b = z.object({ token: z.string().min(20).max(200), password: Password, deviceId: z.string().max(200).optional() }).parse(body);
    const inv = await this.findInvitation(b.token);
    const hash = await hashPassword(b.password);
    await this.db.tx({ tenantId: inv.tenant_id, role: 'SYSTEM' }, async (tx) => {
      // une seule acceptation, même si deux onglets envoient le formulaire en même temps
      const claimed = await tx.query(`UPDATE invitation SET acceptee_le = now() WHERE id = $1 AND acceptee_le IS NULL AND revoquee_le IS NULL RETURNING 1`, [inv.id]);
      if (!claimed.rowCount) throw new BusinessError(410, 'INVITATION_UTILISEE', 'Ce lien a déjà été utilisé');
      await tx.query(`UPDATE utilisateur SET mot_de_passe_hash = $2, statut = 'ACTIF', updated_at = now() WHERE id = $1`, [inv.utilisateur_id, hash]);
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id) VALUES ($1,$2,$3,$4,'INVITATION_ACCEPTEE','utilisateur',$4)`,
        [uuidv7(), inv.tenant_id, inv.entreprise_id, inv.utilisateur_id],
      );
    });
    return this.auth.login({ tenantId: inv.tenant_id, email: inv.email, password: b.password, deviceId: b.deviceId });
  }

  private async findInvitation(token: string) {
    const tenantId = this.tenant();
    const r = await this.db.tx({ tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query<{ id: string; tenant_id: string; entreprise_id: string | null; utilisateur_id: string; expire_le: Date; acceptee_le: Date | null; revoquee_le: Date | null; email: string; nom: string; statut: string; entreprise: string | null }>(
        `SELECT i.id, i.tenant_id, i.entreprise_id, i.utilisateur_id, i.expire_le, i.acceptee_le, i.revoquee_le, u.email, u.nom, u.statut, e.nom AS entreprise
           FROM invitation i JOIN utilisateur u ON u.id = i.utilisateur_id LEFT JOIN entreprise e ON e.id = i.entreprise_id
          WHERE i.token_hash = $1`,
        [tokenHash(token)],
      ),
    );
    const inv = r.rows[0];
    if (!inv || inv.revoquee_le || inv.statut === 'DESACTIVE') throw new BusinessError(410, 'INVITATION_INVALIDE', 'Ce lien d’invitation n’est plus valable. Demandez une nouvelle invitation à votre administrateur.');
    if (inv.acceptee_le) throw new BusinessError(410, 'INVITATION_UTILISEE', 'Ce lien a déjà été utilisé : connectez-vous avec votre adresse e-mail et votre mot de passe.');
    if (inv.expire_le < new Date()) throw new BusinessError(410, 'INVITATION_EXPIREE', 'Ce lien a expiré (validité 7 jours). Demandez une nouvelle invitation à votre administrateur.');
    return inv;
  }

  // ===========================================================================================================
  // Préférences de notification (§6.3)
  // ===========================================================================================================

  @Get('me/preferences')
  preferences(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query<{ p: Record<string, boolean> }>('SELECT preferences_notification AS p FROM utilisateur WHERE id = $1', [user.id]);
      const p = r.rows[0]?.p ?? {};
      const events = OPTIONAL_EVENTS.filter((e) => e.modele !== 'VALIDATION_REQUISE' || user.role === 'B2B_ADMIN');
      return { items: events.map((e) => ({ ...e, email: p[e.modele] !== false })) };
    });
  }

  @Put('me/preferences')
  savePreferences(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const allowed = new Set(OPTIONAL_EVENTS.map((e) => e.modele));
    const b = z.record(z.string(), z.boolean()).parse(body);
    const clean = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.has(k)));
    return this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      // écrit en rôle système : un utilisateur règle ses propres préférences sans droit d'écriture sur les comptes
      await tx.query(`UPDATE utilisateur SET preferences_notification = preferences_notification || $2::jsonb WHERE id = $1`, [user.id, JSON.stringify(clean)]);
      return { ok: true };
    });
  }
}

import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { uuidv7 } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { renderEmail, TRANSACTIONAL, type EmailOverride, type RenderedEmail } from './templates.js';

/** Délais entre deux tentatives d'envoi (puis échec définitif). */
const RETRY_MINUTES = [1, 5, 30];

export interface Enqueue {
  modele: string;
  variables?: Record<string, unknown>;
  destinataireId?: string | null;
  adresse?: string | null;
}

/**
 * File d'envoi des e-mails (§6.3). Les services métier insèrent une ligne `notification` (canal EMAIL) dans leur
 * transaction ; ce service les envoie ensuite, hors transaction métier, avec reprise sur erreur.
 * Sans clé Brevo, les messages sont « journalisés » : rendus et consultables dans le Back-Office, mais non envoyés.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  get provider(): 'BREVO' | 'JOURNAL' {
    return this.config.mail.brevoApiKey ? 'BREVO' : 'JOURNAL';
  }

  onApplicationBootstrap() {
    if (!this.config.mail.worker) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Met un e-mail en file dans la transaction de l'appelant. */
  static async enqueue(tx: Tx, tenantId: string, n: Enqueue): Promise<void> {
    await tx.query(
      `INSERT INTO notification (id, tenant_id, destinataire_id, destinataire_adresse, canal, modele, variables) VALUES ($1,$2,$3,$4,'EMAIL',$5,$6)`,
      [uuidv7(), tenantId, n.destinataireId ?? null, n.adresse ?? null, n.modele, JSON.stringify(n.variables ?? {})],
    );
  }

  async tick(at = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = this.config.defaultTenantId
        ? [this.config.defaultTenantId]
        : (await this.db.pool.query<{ id: string }>('SELECT id FROM organisation')).rows.map((r) => r.id);
      for (const tenantId of orgs) await this.flush(tenantId, at);
    } catch (e) {
      console.error('Envoi des e-mails :', (e as Error).message);
    } finally {
      this.running = false;
    }
  }

  /** Envoie les e-mails en attente d'une organisation ; renvoie le nombre traité. */
  async flush(tenantId: string, at = new Date()): Promise<{ envoyes: number; ignores: number; erreurs: number }> {
    const out = { envoyes: 0, ignores: 0, erreurs: 0 };
    for (;;) {
      const batch = await this.db.tx({ tenantId, role: 'SYSTEM' }, async (tx) => {
        const rows = await tx.query<{
          id: string;
          modele: string;
          variables: Record<string, unknown>;
          tentatives: number;
          destinataire_adresse: string | null;
          email: string | null;
          nom: string | null;
          statut_utilisateur: string | null;
          preferences: Record<string, boolean> | null;
        }>(
          `SELECT n.id, n.modele, n.variables, n.tentatives, n.destinataire_adresse,
                  u.email, u.nom, u.statut AS statut_utilisateur, u.preferences_notification AS preferences
             FROM notification n LEFT JOIN utilisateur u ON u.id = n.destinataire_id
            WHERE n.canal = 'EMAIL' AND n.statut = 'EN_ATTENTE' AND (n.prochaine_tentative IS NULL OR n.prochaine_tentative <= $1)
            ORDER BY n.created_at LIMIT 20 FOR UPDATE OF n SKIP LOCKED`,
          [at],
        );
        const overrides = rows.rowCount ? await this.overrides(tx) : new Map<string, EmailOverride>();
        for (const n of rows.rows) {
          const to = n.destinataire_adresse ?? n.email;
          const skip =
            !to ? 'Aucune adresse' :
            n.statut_utilisateur === 'DESACTIVE' ? 'Utilisateur désactivé' :
            !TRANSACTIONAL.has(n.modele) && n.preferences?.[n.modele] === false ? 'Désactivé dans les préférences' :
            null;
          const mail = skip ? null : renderEmail(n.modele, n.variables, { publicUrl: this.config.publicUrl, destinataire: n.nom }, overrides.get(n.modele));
          if (skip || !mail) {
            await tx.query(`UPDATE notification SET statut = 'IGNOREE', erreur = $2 WHERE id = $1`, [n.id, skip ?? 'Pas de modèle e-mail']);
            out.ignores++;
            continue;
          }
          try {
            await this.send(to!, mail);
            // le lien d'invitation ne reste en base que lorsqu'il n'a pas été réellement envoyé (mode journal)
            const vars = this.provider === 'BREVO' && 'jeton' in n.variables ? { ...n.variables, jeton: null } : n.variables;
            await tx.query(
              `UPDATE notification SET statut = 'ENVOYEE', envoyee_le = $2, objet = $3, fournisseur = $4, destinataire_adresse = $5, variables = $6, erreur = NULL WHERE id = $1`,
              [n.id, at, mail.subject, this.provider, to, JSON.stringify(vars)],
            );
            out.envoyes++;
          } catch (e) {
            const tries = n.tentatives + 1;
            const final = tries > RETRY_MINUTES.length;
            await tx.query(
              `UPDATE notification SET tentatives = $2, erreur = $3, objet = $4, statut = $5, prochaine_tentative = $6 WHERE id = $1`,
              [n.id, tries, (e as Error).message.slice(0, 500), mail.subject, final ? 'ECHEC' : 'EN_ATTENTE', final ? null : new Date(at.getTime() + RETRY_MINUTES[tries - 1]! * 60_000)],
            );
            out.erreurs++;
          }
        }
        return rows.rowCount ?? 0;
      });
      if (batch < 20) break;
    }
    return out;
  }

  private async send(to: string, mail: RenderedEmail): Promise<void> {
    if (this.provider === 'JOURNAL') return;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.config.mail.brevoApiKey!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: this.config.mail.fromEmail, name: this.config.mail.fromName },
        to: [{ email: to }],
        subject: mail.subject,
        htmlContent: mail.html,
        textContent: mail.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status} : ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }

  /** Aperçu d'un e-mail déjà en file (Back-Office). */
  preview(modele: string, variables: Record<string, unknown>, nom: string | null, override?: EmailOverride | null) {
    return renderEmail(modele, variables, { publicUrl: this.config.publicUrl, destinataire: nom }, override);
  }

  /** Textes personnalisés au Back-Office (§6.3), par modèle. */
  async overrides(tx: Tx): Promise<Map<string, EmailOverride>> {
    const r = await tx.query<EmailOverride & { modele: string }>('SELECT modele, sujet, corps, bouton FROM modele_email');
    return new Map(r.rows.map(({ modele, ...o }) => [modele, o]));
  }
}

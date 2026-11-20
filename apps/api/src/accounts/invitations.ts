import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@jamystock/domain';
import type { Tx } from '../db/database.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** ADM-03 : lien d'invitation valable 7 jours, à usage unique. Seul le hash du jeton est conservé en base. */
export const INVITATION_DAYS = 7;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface InvitationResult {
  expireLe: Date;
  /** Lien d'activation, renvoyé à l'administrateur seulement quand aucun service d'e-mail n'est configuré. */
  lien: string;
}

/**
 * Crée (ou remplace) l'invitation d'un utilisateur et met l'e-mail en file. Toute invitation encore ouverte est révoquée,
 * si bien qu'un seul lien fonctionne à la fois.
 */
export async function createInvitation(
  tx: Tx,
  p: { tenantId: string; utilisateurId: string; entrepriseId: string | null; createdBy: string | null; invitePar: string; publicUrl: string; at?: Date },
): Promise<InvitationResult> {
  const at = p.at ?? new Date();
  await tx.query(`UPDATE invitation SET revoquee_le = $2 WHERE utilisateur_id = $1 AND acceptee_le IS NULL AND revoquee_le IS NULL`, [p.utilisateurId, at]);
  const token = randomBytes(32).toString('base64url');
  const expireLe = new Date(at.getTime() + INVITATION_DAYS * 86_400_000);
  await tx.query(
    `INSERT INTO invitation (id, tenant_id, entreprise_id, utilisateur_id, token_hash, expire_le, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), p.tenantId, p.entrepriseId, p.utilisateurId, tokenHash(token), expireLe, at, p.createdBy],
  );
  const ent = p.entrepriseId ? (await tx.query<{ nom: string }>('SELECT nom FROM entreprise WHERE id = $1', [p.entrepriseId])).rows[0]?.nom : undefined;
  await NotificationsService.enqueue(tx, p.tenantId, {
    modele: 'INVITATION',
    destinataireId: p.utilisateurId,
    variables: { jeton: token, entreprise: ent ?? 'JAMYSTOCK', invitePar: p.invitePar, expireLe: expireLe.toISOString() },
  });
  return { expireLe, lien: `${p.publicUrl}/#/invitation/${token}` };
}

import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@jamystock/domain';
import type { Tx } from '../db/database.js';
import type { AuthUser } from '../auth/auth.service.js';

export interface AuditEntry {
  action: string;
  objet: string;
  objetId?: string | null;
  entrepriseId?: string | null;
  avant?: unknown;
  apres?: unknown;
  motif?: string | null;
}

/** Journal d'audit immuable (§5.1, RG-SEC-01) : écrit dans la même transaction que l'action. */
@Injectable()
export class AuditService {
  async record(tx: Tx, actor: AuthUser, entry: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id, avant, apres, motif)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        uuidv7(),
        actor.tenantId,
        entry.entrepriseId ?? null,
        actor.id,
        entry.action,
        entry.objet,
        entry.objetId ?? null,
        entry.avant === undefined ? null : JSON.stringify(entry.avant),
        entry.apres === undefined ? null : JSON.stringify(entry.apres),
        entry.motif ?? null,
      ],
    );
  }
}

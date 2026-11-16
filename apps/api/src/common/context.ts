import type { AuthUser } from '../auth/auth.service.js';
import type { DbContext } from '../db/database.js';

export function ctxOf(user: AuthUser): DbContext {
  return { tenantId: user.tenantId, userId: user.id, role: user.role, entrepriseId: user.entrepriseId };
}

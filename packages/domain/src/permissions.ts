/**
 * RBAC à portée (§2). Le rôle donne le droit ; la portée (entreprise, projets, missions)
 * est appliquée par l'API sur chaque requête puis par la RLS PostgreSQL.
 */
export const ROLES = [
  'B2B_ADMIN',
  'B2B_USER',
  'B2C',
  'SUPER_ADMIN',
  'DISPATCHER',
  'OPERATOR',
  'DRIVER',
] as const;
export type Role = (typeof ROLES)[number];

export const CLIENT_ROLES: readonly Role[] = ['B2B_ADMIN', 'B2B_USER', 'B2C'];
export const STAFF_ROLES: readonly Role[] = ['SUPER_ADMIN', 'DISPATCHER', 'OPERATOR', 'DRIVER'];

export function isClientRole(role: Role): boolean {
  return CLIENT_ROLES.includes(role);
}

/** T = tout (dans sa portée naturelle), P = limité au périmètre, L = lecture seule. */
export type Scope = 'T' | 'P' | 'L';

export const PERMISSIONS = [
  'inventory.read',
  'order.create',
  'order.approve',
  'collection.request',
  'billing.read',
  'company.users.manage',
  'warehouse.manage',
  'pricing.manage',
  'stock.move',
  'picking.execute',
  'delivery.execute',
  'mission.assign',
  'audit.read',
  'client.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Matrice §2.2. Le Dispatcher (rôle complémentaire recommandé) est un Super Admin restreint aux flux :
 * pas de tarifs ni de paramètres dépôt.
 */
export const PERMISSION_MATRIX: Record<Permission, Partial<Record<Role, Scope>>> = {
  'inventory.read': { B2B_ADMIN: 'T', B2B_USER: 'P', B2C: 'T', SUPER_ADMIN: 'T', DISPATCHER: 'T', OPERATOR: 'T', DRIVER: 'P' },
  'order.create': { B2B_ADMIN: 'T', B2B_USER: 'P', B2C: 'T', SUPER_ADMIN: 'T', DISPATCHER: 'T' },
  'order.approve': { B2B_ADMIN: 'T', SUPER_ADMIN: 'T' },
  'collection.request': { B2B_ADMIN: 'T', B2B_USER: 'P', B2C: 'T', SUPER_ADMIN: 'T', DISPATCHER: 'T' },
  'billing.read': { B2B_ADMIN: 'T', B2B_USER: 'L', B2C: 'T', SUPER_ADMIN: 'T' },
  'company.users.manage': { B2B_ADMIN: 'T', SUPER_ADMIN: 'T' },
  'warehouse.manage': { SUPER_ADMIN: 'T' },
  'pricing.manage': { SUPER_ADMIN: 'T' },
  'stock.move': { SUPER_ADMIN: 'T', OPERATOR: 'T' },
  'picking.execute': { SUPER_ADMIN: 'T', OPERATOR: 'P' },
  'delivery.execute': { SUPER_ADMIN: 'T', DRIVER: 'P' },
  'mission.assign': { SUPER_ADMIN: 'T', DISPATCHER: 'T' },
  'audit.read': { B2B_ADMIN: 'L', SUPER_ADMIN: 'T' },
  'client.manage': { SUPER_ADMIN: 'T' },
};

export function scopeFor(role: Role, permission: Permission): Scope | null {
  return PERMISSION_MATRIX[permission][role] ?? null;
}

export function can(role: Role, permission: Permission): boolean {
  return scopeFor(role, permission) !== null;
}

/** MFA obligatoire pour Super Admin et Dispatcher (§7.3). */
export function requiresMfa(role: Role): boolean {
  return role === 'SUPER_ADMIN' || role === 'DISPATCHER';
}

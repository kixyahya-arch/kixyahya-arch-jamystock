import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@jamystock/domain';
import type { AuthUser } from './auth.service.js';

export const IS_PUBLIC = 'jamystock:public';
export const REQUIRED_PERMISSION = 'jamystock:permission';

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Exige une permission de la matrice §2.2 (la portée est ensuite appliquée par le service et la RLS). */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});

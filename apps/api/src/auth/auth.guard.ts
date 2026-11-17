import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@jamystock/domain';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC, REQUIRED_PERMISSION } from './decorators.js';
import { BusinessError, forbidden } from '../common/errors.js';

/** Garde globale : authentifie chaque requête puis vérifie la permission déclarée sur la route. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new BusinessError(401, 'UNAUTHORIZED', 'Authentification requise');
    const user = await this.auth.verifyAccessToken(header.slice(7));
    await this.auth.assertSessionActive(user);
    req.user = user;
    // CLI-02 : la session « en tant que » ne modifie rien
    if (user.impersonation && !['GET', 'HEAD'].includes(req.method)) {
      throw new BusinessError(403, 'LECTURE_SEULE', 'Mode support en lecture seule : aucune modification n’est possible depuis cette session.');
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    if (permission && !can(user.role, permission)) throw forbidden(`Permission ${permission} requise`);
    return true;
  }
}

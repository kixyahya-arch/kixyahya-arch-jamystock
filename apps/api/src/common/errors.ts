import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { InvalidTransitionError, MovementRuleError } from '@jamystock/domain';

/** Erreur métier avec code HTTP explicite. */
export class BusinessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new BusinessError(404, 'NOT_FOUND', `${what} introuvable`);
export const forbidden = (msg = 'Accès refusé') => new BusinessError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string) => new BusinessError(409, code, msg);
export const unprocessable = (code: string, msg: string) => new BusinessError(422, code, msg);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, details?: unknown): void => {
      res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
    };

    if (exception instanceof BusinessError) return send(exception.status, exception.code, exception.message);
    if (exception instanceof InvalidTransitionError) return send(409, 'INVALID_TRANSITION', exception.message);
    if (exception instanceof MovementRuleError) return send(422, 'MOVEMENT_RULE', exception.message);
    if (exception instanceof ZodError) return send(400, 'VALIDATION', 'Requête invalide', exception.issues);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return send(status, HttpStatus[status] ?? 'HTTP_ERROR', exception.message);
    }
    const pgErr = exception as { code?: string; constraint?: string; message?: string };
    if (pgErr?.code === '23505') return send(409, 'UNIQUE_VIOLATION', `Conflit d'unicité (${pgErr.constraint ?? 'contrainte'})`);
    if (pgErr?.code === '42501') return send(403, 'FORBIDDEN', 'Accès refusé');
    if (pgErr?.code === 'P0001') return send(409, 'RULE_VIOLATION', pgErr.message ?? 'Règle métier violée');
    if (pgErr?.code === '23514' || pgErr?.code === '23P01') return send(422, 'CONSTRAINT', pgErr.message ?? 'Contrainte violée');
    console.error(exception);
    return send(500, 'INTERNAL', 'Erreur interne');
  }
}

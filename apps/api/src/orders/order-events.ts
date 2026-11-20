import { Controller, Get, Inject, Injectable, Param, Req, Res, type OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { isClientRole } from '@jamystock/domain';
import { OrdersService } from './orders.service.js';

export interface OrderEvent {
  tenantId: string;
  id: string;
  entrepriseId: string;
  statut: string;
}
type Listener = (e: OrderEvent) => void;

/**
 * SUI-01 : relais des changements de statut publiés par PostgreSQL (déclencheur `commande_statut_notify`).
 * Une seule connexion d'écoute pour tout le serveur, ouverte au premier abonné et rouverte si elle tombe.
 */
@Injectable()
export class OrderEventsService implements OnModuleDestroy {
  private readonly listeners = new Set<Listener>();
  private client: pg.PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async subscribe(l: Listener): Promise<() => void> {
    this.listeners.add(l);
    await this.ensure();
    return () => this.listeners.delete(l);
  }

  private ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= (async () => {
      const c = await this.db.pool.connect();
      c.on('notification', (msg) => {
        if (msg.channel !== 'commande_statut' || !msg.payload) return;
        let e: OrderEvent;
        try {
          e = JSON.parse(msg.payload) as OrderEvent;
        } catch {
          return;
        }
        for (const l of this.listeners) l(e);
      });
      c.on('error', () => {
        c.release(true);
        if (this.client === c) this.client = null;
        if (this.listeners.size && !this.closed) setTimeout(() => void this.ensure().catch(() => undefined), 2000);
      });
      await c.query('LISTEN commande_statut');
      this.client = c;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async onModuleDestroy() {
    this.closed = true;
    this.listeners.clear();
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query('UNLISTEN *').catch(() => undefined);
      c.release();
    }
  }
}

/**
 * Flux d'évènements (Server-Sent Events) : la page de suivi se met à jour sans rechargement.
 * Le droit de voir une commande est vérifié à l'abonnement, sous la RLS de l'utilisateur.
 */
@Controller()
export class OrderEventsController {
  constructor(
    @Inject(OrderEventsService) private readonly events: OrderEventsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /** Une commande précise. */
  @Get('orders/:id/events')
  @RequirePermission('inventory.read')
  async one(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const orderId = z.string().uuid().parse(id);
    await this.orders.get(user, orderId); // 404 si la commande n'est pas visible
    await this.stream(req, res, (e) => e.tenantId === user.tenantId && e.id === orderId);
  }

  /** Toutes les commandes visibles : celles de l'entreprise pour un client, toutes pour l'exploitant. */
  @Get('orders-events')
  @RequirePermission('inventory.read')
  async all(@CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response) {
    const client = isClientRole(user.role);
    // un B2B Utilisateur ne voit que ses projets : il reçoit un simple signal « à rafraîchir », sans identifiant
    const anonyme = user.role === 'B2B_USER';
    await this.stream(req, res, (e) => e.tenantId === user.tenantId && (!client || e.entrepriseId === user.entrepriseId), anonyme);
  }

  private async stream(req: Request, res: Response, keep: (e: OrderEvent) => boolean, anonyme = false) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const unsubscribe = await this.events.subscribe((e) => {
      if (keep(e)) res.write(`event: statut\ndata: ${JSON.stringify(anonyme ? {} : { id: e.id, statut: e.statut })}\n\n`);
    });
    // commentaire toutes les 25 s : garde la connexion ouverte à travers les proxys
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    // fermé au bout de 10 min : la page se reconnecte avec un jeton à jour (une session désactivée ne reste pas abonnée)
    const end = setTimeout(() => res.end(), 10 * 60_000);
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(end);
      unsubscribe();
    });
  }
}

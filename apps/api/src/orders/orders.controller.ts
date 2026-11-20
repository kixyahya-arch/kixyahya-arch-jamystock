import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ORDER_STATUSES, ORDER_TYPES } from '@jamystock/domain';
import { GeocoderService } from '../flux/geocoder.service.js';
import { OrdersService } from './orders.service.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';

const uuid = z.string().uuid();
const isoDate = z.string().date();
const Contact = z.object({ nom: z.string().min(1), telephone: z.string().min(6) });
/** CMD-03 : contraintes d'accès structurées */
const Contraintes = z
  .object({
    etage: z.number().int().optional(),
    ascenseur: z.object({ largeurM: z.number(), profondeurM: z.number(), hauteurM: z.number() }).nullable().optional(),
    accesPL: z.boolean().optional(),
    hauteurLimiteM: z.number().optional(),
    horairesChantier: z.string().optional(),
    consignes: z.string().max(2000).optional(),
  })
  .strict();
const Adresse = z.object({
  libelle: z.string().min(3),
  codePostal: z.string().optional(),
  ville: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  banId: z.string().optional(),
});

const CartBody = z.object({ articleIds: z.array(uuid).min(1).max(500), projetId: uuid.optional() });
const SubmitBody = z.object({
  type: z.enum(['LIVRAISON', 'RETRAIT']),
  adresse: Adresse.optional(),
  contraintesAcces: Contraintes.optional(),
  contactSite: Contact.optional(),
  dateSouhaitee: isoDate,
  creneau: z.string().max(50).optional(),
  depotSansSignature: z.boolean().optional(),
});
const CollectionBody = z.object({
  projetId: uuid.optional(),
  adresse: Adresse,
  contraintesAcces: Contraintes.optional(),
  contactSite: Contact.optional(),
  dateSouhaitee: isoDate,
  creneau: z.string().max(50).optional(),
  description: z.string().min(1).max(5000),
  volumeEstimeM3: z.number().positive().optional(),
  lignes: z.array(z.object({ description: z.string().min(1), quantite: z.number().int().positive().optional() })).max(500).optional(),
  /** Objets déjà connus, installés chez le client : RETOUR au dépôt ou TRANSFERT vers un autre site. */
  nature: z.enum(['NOUVEAUX', 'RETOUR', 'TRANSFERT']).default('NOUVEAUX'),
  articleIds: z.array(uuid).min(1).max(500).optional(),
  destination: z.object({ projetId: uuid.optional(), adresse: Adresse }).optional(),
}).superRefine((b, c) => {
  if (b.nature !== 'NOUVEAUX' && !b.articleIds?.length) c.addIssue({ code: 'custom', path: ['articleIds'], message: 'Choisissez les objets concernés' });
  if (b.nature === 'TRANSFERT' && !b.destination) c.addIssue({ code: 'custom', path: ['destination'], message: 'Adresse du site de destination obligatoire' });
});

@Controller()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(GeocoderService) private readonly geocoder: GeocoderService,
  ) {}

  @Get('cart')
  @RequirePermission('order.create')
  cart(@CurrentUser() user: AuthUser, @Query('projetId') projetId?: string) {
    return this.orders.getCart(user, projetId ? uuid.parse(projetId) : undefined);
  }

  @Post('cart/items')
  @RequirePermission('order.create')
  add(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = CartBody.parse(body);
    return this.orders.addToCart(user, b.articleIds, b.projetId);
  }

  @Delete('cart/items/:articleId')
  @RequirePermission('order.create')
  remove(@CurrentUser() user: AuthUser, @Param('articleId') articleId: string, @Query('projetId') projetId?: string) {
    return this.orders.removeFromCart(user, uuid.parse(articleId), projetId ? uuid.parse(projetId) : undefined);
  }

  @Get('orders')
  @RequirePermission('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    const f = z.object({ statut: z.enum(ORDER_STATUSES).optional(), type: z.enum(ORDER_TYPES).optional() }).parse(q);
    return this.orders.list(user, f);
  }

  @Get('orders/:id')
  @RequirePermission('inventory.read')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.get(user, uuid.parse(id));
  }

  @Post('orders/:id/submit')
  @HttpCode(200)
  @RequirePermission('order.create')
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = SubmitBody.parse(body);
    // SUI-02 : coordonnées de l'adresse pour l'heure d'arrivée estimée (au mieux, sans bloquer la commande)
    return this.orders.submit(user, uuid.parse(id), { ...b, adresse: await this.geocoder.complete(b.adresse) });
  }

  @Post('collections')
  @RequirePermission('collection.request')
  async collection(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = CollectionBody.parse(body);
    return this.orders.requestCollection(user, {
      ...b,
      adresse: await this.geocoder.complete(b.adresse),
      destination: b.destination && { ...b.destination, adresse: await this.geocoder.complete(b.destination.adresse) },
    });
  }

  @Post('orders/:id/approve')
  @HttpCode(200)
  @RequirePermission('order.approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.approve(user, uuid.parse(id));
  }

  @Post('orders/:id/reject')
  @HttpCode(200)
  @RequirePermission('order.approve')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const { motif } = z.object({ motif: z.string().min(3).max(1000) }).parse(body);
    return this.orders.reject(user, uuid.parse(id), motif);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermission('order.create')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const { motif } = z.object({ motif: z.string().max(1000).optional() }).parse(body ?? {});
    return this.orders.cancel(user, uuid.parse(id), motif);
  }

  @Post('orders/:id/plan')
  @HttpCode(200)
  @RequirePermission('mission.assign')
  plan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.plan(user, uuid.parse(id), z.object({ date: isoDate, creneau: z.string().max(50).optional() }).parse(body));
  }

  @Post('orders/:id/counter-propose')
  @HttpCode(200)
  @RequirePermission('mission.assign')
  counter(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.counterPropose(user, uuid.parse(id), z.object({ date: isoDate, message: z.string().max(1000).optional() }).parse(body));
  }

  @Post('orders/:id/accept-date')
  @HttpCode(200)
  @RequirePermission('order.create')
  acceptDate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.acceptCounterProposal(user, uuid.parse(id));
  }
}

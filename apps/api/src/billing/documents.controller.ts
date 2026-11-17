import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { isClientRole } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { forbidden, notFound, unprocessable } from '../common/errors.js';
import { BillingService } from './billing.service.js';
import { zip } from './zip.js';

const uuid = z.string().uuid();
const DocType = z.enum(['FACTURE', 'AVOIR', 'BL']);

const ListQuery = z.object({
  type: DocType.optional(),
  projet: uuid.optional(),
  du: z.string().date().optional(),
  au: z.string().date().optional(),
});

/**
 * SUI-03 : bibliothèque de documents du client (BL signés, factures, avoirs), filtrable par type, projet et période ;
 * PDF horodatés et non modifiables ; téléchargement groupé en ZIP.
 * Un B2B Utilisateur ne voit que les BL de ses projets (RLS sur les commandes) et aucune facture (§2.2 : pas de montants).
 */
@Controller('me/documents')
export class DocumentsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  private clientOnly(user: AuthUser) {
    if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
  }

  private seesInvoices(user: AuthUser) {
    return user.role !== 'B2B_USER';
  }

  @Get()
  @RequirePermission('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.clientOnly(user);
    const q = ListQuery.parse(query);
    return this.db.tx(ctxOf(user), async (tx) => {
      const items: unknown[] = [];
      if (q.type !== 'BL' && this.seesInvoices(user) && !q.projet) {
        const f = await tx.query(
          `SELECT f.id, f.type, f.numero, f.statut, f.emise_le AS date, f.periode_debut AS "periodeDebut", f.periode_fin AS "periodeFin",
                  f.total_ht_cents AS "totalHtCents", f.total_ttc_cents AS "totalTtcCents", f.echeance, o.numero AS "origineNumero", NULL::text AS projet
             FROM facture f LEFT JOIN facture o ON o.id = f.facture_origine_id
            WHERE f.statut <> 'BROUILLON' AND ($1::type_facture IS NULL OR f.type = $1)
              AND ($2::date IS NULL OR (f.emise_le AT TIME ZONE 'Europe/Paris')::date >= $2)
              AND ($3::date IS NULL OR (f.emise_le AT TIME ZONE 'Europe/Paris')::date <= $3)`,
          [q.type ?? null, q.du ?? null, q.au ?? null],
        );
        items.push(...f.rows);
      }
      if (!q.type || q.type === 'BL') {
        // jointure sur commande : la RLS limite un B2B Utilisateur aux BL de ses projets
        const b = await tx.query(
          `SELECT b.id, 'BL' AS type, b.numero, b.type AS "typeBl", coalesce(b.signe_le, b.recu_le) AS date, c.numero AS commande,
                  c.type AS "typeCommande", p.nom AS projet,
                  (SELECT count(*)::int FROM reserve r WHERE r.bl_id = b.id) AS "nbReserves"
             FROM bon_de_livraison b JOIN commande c ON c.id = b.commande_id LEFT JOIN projet p ON p.id = c.projet_id
            WHERE b.statut = 'SIGNE' AND ($1::uuid IS NULL OR c.projet_id = $1)
              AND ($2::date IS NULL OR (coalesce(b.signe_le, b.recu_le) AT TIME ZONE 'Europe/Paris')::date >= $2)
              AND ($3::date IS NULL OR (coalesce(b.signe_le, b.recu_le) AT TIME ZONE 'Europe/Paris')::date <= $3)`,
          [q.projet ?? null, q.du ?? null, q.au ?? null],
        );
        items.push(...b.rows);
      }
      items.sort((a, b) => new Date((b as { date: string }).date).getTime() - new Date((a as { date: string }).date).getTime());
      return { items, total: items.length, factures: this.seesInvoices(user) };
    });
  }

  private async file(user: AuthUser, type: z.infer<typeof DocType>, id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      if (type === 'BL') {
        const visible = await tx.query('SELECT 1 FROM bon_de_livraison b JOIN commande c ON c.id = b.commande_id WHERE b.id = $1', [id]);
        if (!visible.rowCount) throw notFound('Document');
        return this.billing.blFile(tx, id);
      }
      if (!this.seesInvoices(user)) throw forbidden('Les factures sont réservées aux administrateurs du compte');
      const visible = await tx.query(`SELECT 1 FROM facture WHERE id = $1 AND type = $2 AND statut <> 'BROUILLON'`, [id, type]);
      if (!visible.rowCount) throw notFound('Document');
      return this.billing.invoiceFile(tx, id);
    });
  }

  @Get(':type/:id/pdf')
  @RequirePermission('inventory.read')
  async pdf(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id') id: string, @Res() res: Response) {
    this.clientOnly(user);
    const f = await this.file(user, DocType.parse(type.toUpperCase()), uuid.parse(id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${f.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.data);
  }

  /** Téléchargement groupé (50 documents au plus par archive). */
  @Post('zip')
  @RequirePermission('inventory.read')
  async zip(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res() res: Response) {
    this.clientOnly(user);
    const b = z.object({ items: z.array(z.object({ type: DocType, id: uuid })).min(1).max(50) }).parse(body);
    const files = [];
    for (const it of b.items) files.push(await this.file(user, it.type, it.id));
    if (!files.length) throw unprocessable('VIDE', 'Aucun document');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="documents-jamystock.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(zip(files));
  }
}

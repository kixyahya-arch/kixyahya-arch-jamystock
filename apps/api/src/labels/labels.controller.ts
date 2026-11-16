import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { generateQrCode, qrUrl } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';

/**
 * O1 / WMS-03 : planches de QR vierges pré-imprimées. Renvoie les codes et leurs URL ;
 * le rendu PDF A4 (Avery) et ZPL (Zebra 50 × 25 mm) arrive en phase D.
 */
@Controller('labels')
export class LabelsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Post('blank')
  @RequirePermission('stock.move')
  async blank(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = z.object({ type: z.enum(['A', 'U']).default('A'), count: z.number().int().min(1).max(1000), lot: z.string().max(100).optional() }).parse(body);
    const lot = b.lot ?? `LOT-${new Date().toISOString().slice(0, 10)}`;
    return this.db.tx(ctxOf(user), async (tx) => {
      const codes: string[] = [];
      while (codes.length < b.count) {
        const code = generateQrCode(b.type);
        const r = await tx.query('INSERT INTO qr_vierge (qr_code, tenant_id, lot) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [code, user.tenantId, lot]);
        if (r.rowCount) codes.push(code);
      }
      return { lot, codes: codes.map((code) => ({ code, url: qrUrl(code) })) };
    });
  }
}

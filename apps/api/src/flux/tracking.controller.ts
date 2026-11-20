import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { Public } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { TrackingService } from './tracking.service.js';

/** SUI-02 : page de suivi publique, sans connexion. Le lien porte lui-même l'autorisation (48 h). */
@Controller('public/suivi')
export class PublicTrackingController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TrackingService) private readonly tracking: TrackingService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get(':token')
  async show(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const t = this.tracking.parse(token);
    const s = await this.db.tx({ tenantId: t.tenantId, role: 'SYSTEM' }, (tx) => this.tracking.state(tx, t.missionId));
    if (!s) throw notFound('Suivi');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    const { missionId: _m, ...rest } = s;
    return { ...rest, expireLe: t.expireLe.toISOString(), rafraichirDansS: 60, tuiles: this.config.mapTilesUrl };
  }
}

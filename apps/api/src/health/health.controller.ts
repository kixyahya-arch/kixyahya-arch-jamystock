import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Public()
  @Get()
  async health() {
    await this.db.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}

import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CONFIG, DATABASE } from './common/tokens.js';
import type { AppConfig } from './config.js';
import { Database } from './db/database.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AllExceptionsFilter } from './common/errors.js';
import { AuditService } from './audit/audit.service.js';
import { InventoryController } from './inventory/inventory.controller.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { HealthController } from './health/health.controller.js';
import { FieldController } from './field/field.controller.js';
import { FieldService } from './field/field.service.js';
import { StorageService } from './storage/storage.service.js';
import { MissionsController } from './missions/missions.controller.js';
import { LabelsController } from './labels/labels.controller.js';

/** Monolithe modulaire (§7.1) : un module Nest par domaine métier au fil des phases. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, db?: Database): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, InventoryController, OrdersController, FieldController, MissionsController, LabelsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DATABASE, useValue: db ?? new Database(config.appDatabaseUrl) },
        AuthService,
        AuditService,
        OrdersService,
        FieldService,
        StorageService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}

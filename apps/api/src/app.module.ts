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
import { FilesController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { ClientController } from './client/client.controller.js';
import { BackofficeController } from './backoffice/backoffice.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { WarehouseController } from './warehouse/warehouse.controller.js';
import { DocumentsController } from './billing/documents.controller.js';
import { BillingService } from './billing/billing.service.js';
import { BillingScheduler } from './billing/billing.scheduler.js';
import { AccountsController } from './accounts/accounts.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { DunningService } from './billing/dunning.service.js';
import { SupportController } from './support/support.controller.js';
import { ArticleClientController, ClientInventoryController, InventoryExportService } from './inventory/client-inventory.controller.js';
import { PilotageController } from './pilotage/pilotage.controller.js';

/** Monolithe modulaire (§7.1) : un module Nest par domaine métier au fil des phases. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, db?: Database): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, InventoryController, OrdersController, FieldController, MissionsController, LabelsController, FilesController, ClientController, BackofficeController, BillingController, DocumentsController, WarehouseController, AccountsController, NotificationsController, PaymentsController, SupportController, PilotageController, ClientInventoryController, ArticleClientController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DATABASE, useValue: db ?? new Database(config.appDatabaseUrl) },
        AuthService,
        AuditService,
        OrdersService,
        FieldService,
        StorageService,
        FilesService,
        BillingService,
        BillingScheduler,
        NotificationsService,
        PaymentsService,
        DunningService,
        InventoryExportService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}

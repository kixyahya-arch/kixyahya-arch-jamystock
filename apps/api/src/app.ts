import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';

export async function createApp(config: AppConfig, db?: Database): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, db), { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();
  return app;
}

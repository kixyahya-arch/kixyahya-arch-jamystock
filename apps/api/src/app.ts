import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';

export async function createApp(config: AppConfig, db?: Database): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, db), { logger: ['error', 'warn'] });
  // binaire des photos terrain (PUT /field/photos/:id)
  app.use('/api/v1/field/photos', express.raw({ type: ['image/webp', 'image/jpeg', 'image/png'], limit: '2mb' }));
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();
  return app;
}

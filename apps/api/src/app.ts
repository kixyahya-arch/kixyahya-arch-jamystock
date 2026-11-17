import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { serveFrontends } from './frontends.js';

export async function createApp(config: AppConfig, db?: Database): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, db), { logger: ['error', 'warn'] });
  // binaire des photos terrain (PUT /field/photos/:id)
  app.use('/api/v1/field/photos', express.raw({ type: ['image/webp', 'image/jpeg', 'image/png'], limit: '2mb' }));
  // webhook Stripe : la signature porte sur le corps brut
  app.use('/api/v1/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  // en production, une seule adresse sert l'Espace Client (/) et l'app terrain (/terrain/)
  serveFrontends(app, config.frontends);
  app.enableShutdownHooks();
  return app;
}

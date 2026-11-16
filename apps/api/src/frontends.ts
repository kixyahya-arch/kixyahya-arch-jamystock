import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';

/**
 * Sert les builds des applis web depuis l'API : l'Espace Client à la racine, l'app terrain sous /terrain/.
 * Une seule adresse, donc ni CORS ni configuration de proxy chez l'hébergeur.
 * Les fichiers versionnés (/assets/*-hash.js) sont mis en cache longtemps ; les pages, jamais.
 */
export function serveFrontends(app: INestApplication, dirs: { client?: string; terrain?: string }) {
  const headers = (res: Response, file: string) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (file.endsWith('.html') || file.endsWith('sw.js') || file.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    } else if (file.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  };
  const spa = (dir: string, prefix: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || !req.path.startsWith(prefix) || req.path.startsWith('/api/') || req.path === '/health') return next();
    if (path.extname(req.path)) return next(); // fichier absent : 404 normal
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.sendFile(path.resolve(dir, 'index.html'));
  };
  if (dirs.terrain) {
    app.use('/terrain', express.static(path.resolve(dirs.terrain), { index: 'index.html', setHeaders: headers }));
    app.use(spa(dirs.terrain, '/terrain'));
  }
  if (dirs.client) {
    app.use(express.static(path.resolve(dirs.client), { index: 'index.html', setHeaders: headers }));
    app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/terrain') ? next() : spa(dirs.client!, '/')(req, res, next)));
  }
}

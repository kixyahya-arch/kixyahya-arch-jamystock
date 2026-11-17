import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Servi par l'API sous /admin/ en production (une seule adresse pour les trois applis)
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: { '@jamystock/domain/browser': fileURLToPath(new URL('../../packages/domain/src/browser.ts', import.meta.url)) },
  },
  server: { port: 5175, proxy: { '/api': 'http://localhost:3000' } },
  preview: { port: 4175, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom' },
} as never);

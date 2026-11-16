import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Servi par l'API sous /admin/ en production (une seule adresse pour les trois applis)
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { port: 5175, proxy: { '/api': 'http://localhost:3000' } },
  preview: { port: 4175, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom' },
} as never);

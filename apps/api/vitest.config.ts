import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@jamystock/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
  },
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});

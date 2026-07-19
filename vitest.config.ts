import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/engine/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});

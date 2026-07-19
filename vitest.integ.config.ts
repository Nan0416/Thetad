import { defineConfig } from 'vitest/config';

// Integration tests hit the real Alpaca paper API: separate config so
// `npm test` stays fast and offline. Run with `npm run test:integ`.
export default defineConfig({
  test: {
    include: ['packages/*/integ/**/*.integ.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

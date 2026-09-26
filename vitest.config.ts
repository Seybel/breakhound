import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Most test files start a browser; one per core at once is more than a laptop wants.
    maxWorkers: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
  },
});

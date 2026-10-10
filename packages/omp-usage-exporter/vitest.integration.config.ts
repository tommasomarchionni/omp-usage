import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    pool: 'forks',
    // Spawned processes and real timers.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // better-sqlite3 is a native addon: worker threads can crash on some
    // Node versions, child processes are isolated and safe.
    pool: 'forks',
  },
});

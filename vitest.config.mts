import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Tests use .env.test (a separate database).
config({ path: '.env.test' });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // TEST_FAST=1 (set by scripts/test-shards.sh): cheap password hashes for fixture users, see the file
    setupFiles: process.env.TEST_FAST === '1' ? ['tests/setup/fast-argon.ts'] : [],
  },
});

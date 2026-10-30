import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Tests use .env.test (a separate database).
config({ path: '.env.test' });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEVTOOLS__: 'true',
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // Domain code must not depend on wall-clock time; tests that need time
    // inject explicit timestamps.
    restoreMocks: true,
  },
});

import { defineConfig } from 'vitest/config';

/** Report generators (not tests): `npm run report:signal`. */
export default defineConfig({
  define: { __DEVTOOLS__: 'true' },
  test: { include: ['tests/benchmarks/**/*.report.ts'], environment: 'node', testTimeout: 600_000 },
});

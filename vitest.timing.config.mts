import { configDefaults, defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

// One file at a time and without coverage, so no other work slows the time a test takes.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['**/*.timing.spec.ts'], exclude: configDefaults.exclude, fileParallelism: false },
});

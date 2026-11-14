import { configDefaults, defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

// One file at a time and without coverage, so no other work slows the time a test takes.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.timing.spec.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    // Each test does its work many times over at two sizes, and a busy machine takes several times as long as CI.
    testTimeout: 120_000,
    execArgv: [
      // So each measure starts on a clean heap.
      '--expose-gc',
      // A young generation that holds the larger size, so moving what outgrows it costs no measure more than its size.
      '--max-semi-space-size=64',
    ],
  },
});

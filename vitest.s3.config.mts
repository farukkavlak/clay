import { configDefaults, defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

// Only the tests that need an S3 server, which the environment names.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.s3.spec.ts'],
    exclude: configDefaults.exclude,
  },
});

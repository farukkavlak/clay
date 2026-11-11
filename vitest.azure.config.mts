import { configDefaults, defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

// Only the tests that need an Azure Blob server, which the environment names.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.azure.spec.ts'],
    exclude: configDefaults.exclude,
  },
});

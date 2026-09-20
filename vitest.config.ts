import path from 'node:path';
import { defineConfig } from 'vitest/config';

const packages = {
  cli: 'packages/cli',
  contracts: 'packages/contracts',
  graph: 'packages/graph',
  orchestrator: 'packages/orchestrator',
  parser: 'packages/parser',
  planner: 'packages/planner',
  state: 'packages/state',
  'provider-local': 'providers/local',
};

// Tests read the other packages' source, so a stale or missing `dist` can neither pass nor fail them.
export default defineConfig({
  // The CLI colours its output on a terminal; tests compare plain text.
  test: { env: { NO_COLOR: '1' } },
  resolve: {
    // The root tsconfig compiles as CommonJS, which has no import.meta.dirname.
    // eslint-disable-next-line unicorn/prefer-module
    alias: Object.fromEntries(Object.entries(packages).map(([name, dir]) => [`@clay/${name}`, path.resolve(__dirname, dir, 'src/index.ts')])),
  },
});

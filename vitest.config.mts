import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

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
  test: {
    // The CLI colours its output on a terminal; tests compare plain text.
    env: { NO_COLOR: '1' },
    // A test against real files takes about a second alone, and past 5 when many run in parallel under coverage.
    testTimeout: 15_000,
    // Tests that time how work grows run alone, after these.
    exclude: [...configDefaults.exclude, '**/*.timing.spec.ts'],
  },
  resolve: {
    alias: Object.fromEntries(Object.entries(packages).map(([name, dir]) => [`@clay/${name}`, path.resolve(import.meta.dirname, dir, 'src/index.ts')])),
  },
});

import { RunEvent } from '@clay/orchestrator';

import { TestEngine } from './helpers';

export async function* start(engine: TestEngine, config: string): AsyncGenerator<RunEvent> {
  yield* engine.runPlan(await engine.plan(config), config);
}

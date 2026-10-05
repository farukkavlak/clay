import { Orchestrator, RunEvent } from '@clay/orchestrator';

export async function* start(engine: Orchestrator, config: string): AsyncGenerator<RunEvent> {
  yield* engine.runPlan(await engine.plan(config), config);
}

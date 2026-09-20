import { Orchestrator, RunEvent } from '@clay/orchestrator';

/** Plans and runs that plan, as apply does. */
export async function* start(engine: Orchestrator, config: string): AsyncGenerator<RunEvent> {
  yield* engine.runPlan(await engine.plan(config), config);
}

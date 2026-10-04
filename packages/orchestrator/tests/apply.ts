import { Output } from '@clay/contracts';

import { Orchestrator } from '../src/index';

/** Runs to the end and returns the outputs; a failed action becomes the thrown error. */
export async function apply(orchestrator: Orchestrator, configContent: string): Promise<Record<string, Output>> {
  let outputs: Record<string, Output> = {};

  const planned = await orchestrator.plan(configContent);
  for await (const event of orchestrator.runPlan(planned, configContent)) {
    if (event.type === 'failed') throw event.error;
    if (event.type === 'done') outputs = event.outputs;
  }

  return outputs;
}

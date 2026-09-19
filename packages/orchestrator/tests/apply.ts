import { Orchestrator } from '../src/index';

/** Runs to the end and returns the outputs; a failed action becomes the thrown error. */
export async function apply(orchestrator: Orchestrator, configContent: string): Promise<Record<string, unknown>> {
  let outputs: Record<string, unknown> = {};

  for await (const event of orchestrator.run(configContent)) {
    if (event.type === 'failed') throw event.error;
    if (event.type === 'done') outputs = event.outputs;
  }

  return outputs;
}

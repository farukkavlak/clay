import { CreateRequest, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema, UpdateRequest } from '@clay/contracts';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function run(planned: Record<string, unknown>): Promise<string> {
  const { stdout } = await execAsync(planned.command as string, { cwd: (planned.cwd as string) || process.cwd() });
  return stdout;
}

export class CommandExecResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      command: { type: 'string', required: true, forceNew: false }, // Re-exec allows update
      cwd: { type: 'string', required: false, forceNew: false },
      stdout: { type: 'string', computed: true },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (inputs.command === '') throw new Error('command_exec "command" must not be empty');
  }

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // Nothing outside the state holds it, so it is as it was applied.
  async read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create({ planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: crypto.randomUUID(), stdout: await run(planned) };
  }

  async update({ planned }: UpdateRequest): Promise<Record<string, unknown>> {
    return { ...planned, stdout: await run(planned) };
  }

  async delete(_prior: Record<string, unknown>): Promise<void> {}
}

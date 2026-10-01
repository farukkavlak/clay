import { PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema } from '@clay/contracts';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { idOf } from './idOf';

const execAsync = promisify(exec);

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
    if (!inputs.command || typeof inputs.command !== 'string') throw new Error('command_exec requires "command" attribute (string)');
  }

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // Nothing outside the state holds it, so it is as it was applied.
  async read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    const { stdout } = await execAsync(command, { cwd });

    return { ...inputs, id: crypto.randomUUID(), stdout };
  }

  async update(prior: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    const { stdout } = await execAsync(command, { cwd });

    return { ...inputs, id: idOf(prior), stdout };
  }

  async delete(_prior: Record<string, unknown>): Promise<void> {}
}

import { PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema } from '@clay/contracts';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export class CommandExecResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
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
  async read(_id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    const { stdout } = await execAsync(command, { cwd });

    return { id: crypto.randomUUID(), attributes: { ...inputs, stdout } };
  }

  async update(_id: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    const { stdout } = await execAsync(command, { cwd });

    return { ...inputs, stdout };
  }

  async delete(_id: string): Promise<void> {}
}

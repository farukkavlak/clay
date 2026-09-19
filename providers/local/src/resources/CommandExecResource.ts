import { IResourceHandler, ISchema } from '@clay/contracts';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export class CommandExecResource implements IResourceHandler {
  async getSchema(): Promise<ISchema> {
    return {
      command: { type: 'string', required: true, forceNew: false }, // Re-exec allows update
      cwd: { type: 'string', required: false, forceNew: false },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (!inputs.command || typeof inputs.command !== 'string') throw new Error('command_exec requires "command" attribute (string)');
  }

  async create(inputs: Record<string, unknown>): Promise<string> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    await execAsync(command, { cwd });

    return crypto.randomUUID();
  }

  async update(_id: string, inputs: Record<string, unknown>): Promise<void> {
    const command = inputs.command as string;
    const cwd = (inputs.cwd as string) || process.cwd();

    await execAsync(command, { cwd });
  }

  async delete(_id: string): Promise<void> {
    // No-op
  }

  async read(_inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}

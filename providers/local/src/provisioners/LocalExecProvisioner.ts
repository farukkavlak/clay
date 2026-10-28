import { Provisioner, Schema, types } from '@clay/contracts';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** Runs a command on the machine Clay runs on, from the directory it runs in. */
export class LocalExecProvisioner implements Provisioner {
  readonly type = 'local-exec';

  async getSchema(): Promise<Schema> {
    return { command: { type: types.string, required: true } };
  }

  async validate(config: Record<string, unknown>): Promise<void> {
    if (config.command === '') throw new Error('local-exec "command" must not be empty');
  }

  async run(config: Record<string, unknown>): Promise<void> {
    await execAsync(config.command as string);
  }
}

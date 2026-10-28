import { Provisioner, Schema, types } from '@clay/contracts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

/** Every line read from `stream`, given as it comes; resolves once the stream ends. */
function readLines(stream: Readable, output: (line: string) => void): Promise<unknown> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', output);
  return once(lines, 'close');
}

/** Runs a command on the machine Clay runs on, from the directory it runs in. What it prints on stdout and stderr is given line by line. */
export class LocalExecProvisioner implements Provisioner {
  readonly type = 'local-exec';

  async getSchema(): Promise<Schema> {
    return {
      command: { type: types.string, required: true },
      // The command is not shown; what it prints still is.
      quiet: { type: types.bool, required: false },
    };
  }

  async validate(config: Record<string, unknown>): Promise<void> {
    if (config.command === '') throw new Error('local-exec "command" must not be empty');
  }

  async run(config: Record<string, unknown>, output: (line: string) => void): Promise<void> {
    const command = config.command as string;
    if (config.quiet !== true) output(`Executing: ${JSON.stringify(command)}`);

    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const read = Promise.all([readLines(child.stdout, output), readLines(child.stderr, output)]);
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    await read;

    // Not the command, which `quiet` keeps from being shown.
    if (signal) throw new Error(`the command was stopped by ${signal}`);
    if (code !== 0) throw new Error(`the command exited with ${code}`);
  }
}

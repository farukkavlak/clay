import { isUnknown, Provisioner, Schema, types } from '@clay/contracts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

/** Every line read from `stream`, given as it comes; resolves once the stream ends. */
function readLines(stream: Readable, output: (line: string) => void): Promise<unknown> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', output);
  return once(lines, 'close');
}

/** Spawn reports a missing directory as the shell not found, so it is checked first. */
async function checkDirectory(dir: string): Promise<void> {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) return;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  throw new Error(`working_dir ${JSON.stringify(dir)} is not a directory`);
}

/** `=` would split the name and NUL cut it or its value short, so either is refused. */
function checkVariable(name: string, value: unknown): void {
  if (name === '' || name.includes('=') || name.includes('\0')) throw new Error(`local-exec "environment" cannot name a variable ${JSON.stringify(name)}`);
  if (typeof value === 'string' && value.includes('\0')) throw new Error(`local-exec "environment" gives ${name} a NUL character`);
}

/** Clay's own environment, with each variable given set over it; one given null is left as it is. */
function environmentOf(given: unknown): NodeJS.ProcessEnv | undefined {
  if (given === null || given === undefined) return undefined;

  const set = Object.entries(given as Record<string, string | null>).filter((entry): entry is [string, string] => entry[1] !== null);
  return { ...process.env, ...Object.fromEntries(set) };
}

/** Runs a command on the machine Clay runs on, from the directory it runs in or `working_dir`. What it prints on stdout and stderr is given line by line. */
export class LocalExecProvisioner implements Provisioner {
  readonly type = 'local-exec';

  async getSchema(): Promise<Schema> {
    return {
      command: { type: types.string, required: true },
      working_dir: { type: types.string, required: false },
      environment: { type: types.map(types.string), required: false },
      // The command is not shown; what it prints still is.
      quiet: { type: types.bool, required: false },
    };
  }

  async validate(config: Record<string, unknown>): Promise<void> {
    if (config.command === '') throw new Error('local-exec "command" must not be empty');
    if (config.working_dir === '') throw new Error('local-exec "working_dir" must not be empty');

    const { environment } = config;
    if (environment === null || environment === undefined || isUnknown(environment)) return;
    for (const [name, value] of Object.entries(environment as Record<string, unknown>)) checkVariable(name, value);
  }

  async run(config: Record<string, unknown>, output: (line: string) => void): Promise<void> {
    const command = config.command as string;
    const cwd = (config.working_dir as string | null) ?? undefined;
    if (cwd !== undefined) await checkDirectory(cwd);
    if (config.quiet !== true) output(`Executing: ${JSON.stringify(command)}`);

    const child = spawn(command, { shell: true, cwd, env: environmentOf(config.environment), stdio: ['ignore', 'pipe', 'pipe'] });
    const read = Promise.all([readLines(child.stdout, output), readLines(child.stderr, output)]);
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    await read;

    // Not the command, which `quiet` keeps from being shown.
    if (signal) throw new Error(`the command was stopped by ${signal}`);
    if (code !== 0) throw new Error(`the command exited with ${code}`);
  }
}

import { Orchestrator, DiskFiles } from '@clay/orchestrator';
import { Provider } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

/** The CLI as a user runs it. */
export const clay = path.resolve(__dirname, '../../bin/clay.js');

/** An engine on the state and the files in `dir`, with the providers given, or the local one where none is. */
export function orchestratorIn(dir: string, ...providers: Provider[]): Orchestrator {
  const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
  for (const provider of providers.length > 0 ? providers : [new LocalProvider()]) engine.registerProvider(provider);
  return engine;
}

/** What the CLI prints, with its colours taken out, run in `dir`. */
export async function clayOutput(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
  return stripVTControlCharacters(stdout);
}

/** Where `needle` first stands in `config`, as an error places it. */
export const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

/** The ConfigError a run is refused with; any other error is rethrown. */
export const errorOf = async (run: () => Promise<unknown>): Promise<ConfigError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

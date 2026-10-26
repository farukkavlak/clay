import { DiskFiles, Orchestrator, RunEvent, RunOptions } from '@clay/orchestrator';
import { Provider } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { Plan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

/** The CLI as a user runs it. */
export const clay = path.resolve(__dirname, '../../bin/clay.js');

/** The engine as a test drives it: each call first writes `config` as main.clay, where the engine reads it. */
export class TestEngine {
  constructor(
    private engine: Orchestrator,
    private write: (config: string) => Promise<void>
  ) {}

  registerProvider(provider: Provider): void {
    this.engine.registerProvider(provider);
  }

  async plan(config: string, options?: { refresh?: boolean }): Promise<Plan> {
    await this.write(config);
    return this.engine.plan(options);
  }

  async validate(config: string): Promise<void> {
    await this.write(config);
    return this.engine.validate();
  }

  async *runPlan(saved: Plan, config: string, options?: RunOptions): AsyncGenerator<RunEvent> {
    await this.write(config);
    yield* this.engine.runPlan(saved, options);
  }
}

/** `engine`, driven with each configuration written to main.clay in `dir`. */
export function engineIn(dir: string, engine: Orchestrator): TestEngine {
  return new TestEngine(engine, (config) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8'));
}

/** An engine on the state and the files in `dir`, with the providers given, or the local one where none is. */
export function orchestratorIn(dir: string, ...providers: Provider[]): TestEngine {
  const engine = engineIn(dir, Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir)));
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

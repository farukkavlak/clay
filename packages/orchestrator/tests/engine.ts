import { Provider } from '@clay/contracts';
import { CONFIG_FILE } from '@clay/parser';
import { Plan } from '@clay/planner';
import { StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DiskFiles, InMemoryFiles, Orchestrator, RunEvent, RunOptions } from '../src/index';

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

/** An engine reading `files`, which main.clay is put into. */
export function engineOn(stateManager: StateManager, files: Record<string, string> = {}): TestEngine {
  return new TestEngine(Orchestrator.create(stateManager, new InMemoryFiles(files)), async (config) => {
    files[CONFIG_FILE] = config;
  });
}

/** An engine reading the files in `dir`. */
export function engineIn(stateManager: StateManager, dir: string): TestEngine {
  return new TestEngine(Orchestrator.create(stateManager, new DiskFiles(dir)), (config) => fs.writeFile(path.join(dir, CONFIG_FILE), config, 'utf8'));
}

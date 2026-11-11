import { Provider } from '@clay/contracts';
import { Plan } from '@clay/planner';
import { StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DiskFiles, InMemoryFiles, Orchestrator, RunEvent, RunOptions } from '../src/index';

/** The engine as a test drives it: each call first writes `config` as main.clay, where the engine reads it. */
export class TestEngine {
  constructor(
    private engine: Orchestrator,
    private manager: StateManager,
    private write: (config: string) => Promise<void>
  ) {}

  registerProvider(provider: Provider): void {
    this.engine.registerProvider(provider);
  }

  async plan(config: string, options?: { refresh?: boolean }): Promise<Plan> {
    await this.write(config);
    return this.locked('plan', () => this.engine.plan(options));
  }

  async validate(config: string): Promise<void> {
    await this.write(config);
    return this.engine.validate();
  }

  async *runPlan(saved: Plan, config: string, options?: RunOptions): AsyncGenerator<RunEvent> {
    await this.write(config);
    if (this.manager.held) {
      yield* this.engine.runPlan(saved, options);
      return;
    }

    await this.manager.lock('apply');
    try {
      yield* this.engine.runPlan(saved, options);
    } catch (error) {
      await this.manager.unlockAfter(error);
    } finally {
      await this.manager.unlock();
    }
  }

  /** As a command runs it: under a lock taken for the call, unless the test holds one. */
  private async locked<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (this.manager.held) return work();

    await this.manager.lock(operation);
    try {
      return await work();
    } catch (error) {
      return await this.manager.unlockAfter(error);
    } finally {
      await this.manager.unlock();
    }
  }
}

/** An engine reading `files`, which main.clay is put into. */
export function engineOn(stateManager: StateManager, files: Record<string, string> = {}): TestEngine {
  return new TestEngine(Orchestrator.create(stateManager, new InMemoryFiles(files)), stateManager, async (config) => {
    files['main.clay'] = config;
  });
}

/** An engine reading the files in `dir`. */
export function engineIn(stateManager: StateManager, dir: string): TestEngine {
  return new TestEngine(Orchestrator.create(stateManager, new DiskFiles(dir)), stateManager, (config) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8'));
}

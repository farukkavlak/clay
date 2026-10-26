import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const errorOf = async (run: () => Promise<unknown>): Promise<ConfigError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

const RANDOM = 'resource "random_string" "r" { length = 4 }';

/** A list of numbers that only the apply knows. */
const NUMBERS = 'tolist(toset([length(random_string.r.result)]))';

describe('a value not known yet given to a variable', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const withModule = async (variable: string, given: string) => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `variable "v" {\n  type = ${variable}\n}`, 'utf8');

    return `${RANDOM}\nmodule "m" {\n  source = "./m"\n  v      = ${given}\n}`;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unknown-parts-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['plan', (config: string) => newOrchestrator().plan(config)],
    ['validate', (config: string) => newOrchestrator().validate(config)],
  ])('is refused by %s when its items can never be what the variable takes', async (_, run) => {
    const config = await withModule('list(bool)', NUMBERS);

    const error = await errorOf(() => run(config));

    expect(error.message).toBe('v holds a number, where variable "v" takes a boolean');
    expect(error.block).toBe('module "m"');
  });

  it('is planned when its items may be what the variable takes once they are known', async () => {
    const config = await withModule('list(bool)', '[random_string.r.result]');

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.type)).toEqual(['CREATE']);
  });
});

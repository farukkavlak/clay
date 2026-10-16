import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DB = `
  output "secret" {
    value     = "hunter2"
    sensitive = true
  }
  output "size" {
    value     = 424242.5
    sensitive = true
  }
`;

const MODULE = 'module "db" { source = "./db" }\n';

class Base implements Provider {
  readonly resources: string[] = [];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return { label: { type: types.string, required: true } };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(_type: string, _config: Record<string, unknown>): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return { content: { type: types.string, optional: true } };
  }

  async validateDataSource(_type: string, _config: Record<string, unknown>): Promise<void> {}

  async readDataSource(_type: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return config;
  }
}

/** Applies a label upper-cased, with a value it never planned. */
class Loud extends Base {
  override readonly resources = ['loud'];

  override async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { label: String(config.label).toUpperCase(), volume: 'high' };
  }
}

/** Plans a label the configuration did not set. */
class Wrong extends Base {
  override readonly resources = ['wrong'];

  override async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(await this.getSchema(), request);
    return { after: { ...after, label: 'other' }, replace };
  }
}

const outputOf = (value: string, sensitive: boolean) => `output "secret" {\n  value = "${value}"\n  sensitive = ${sensitive}\n}`;

const SECRET = (label: unknown) => String(label).startsWith('hunter');

/** Plans a label the configuration did not set, for a secret label only. */
class WrongOnSecret extends Base {
  override readonly resources = ['wrong_on_secret'];

  override async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(await this.getSchema(), request);
    return { after: SECRET(request.config.label) ? { ...after, label: 'other' } : after, replace };
  }
}

/** Throws from its plan, quoting a secret label. */
class PlanThrowing extends Base {
  override readonly resources = ['plan_throwing'];

  override async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    if (SECRET(request.config.label)) throw new Error(`label "${String(request.config.label)}" cannot be planned`);
    return super.plan(type, request);
  }
}

/** Throws a string, not an Error, quoting the label. */
class Shouting extends Base {
  override readonly resources = ['shouting'];

  override async validate(_type: string, config: Record<string, unknown>): Promise<void> {
    throw `label "${String(config.label)}" is shouted`;
  }
}

/** Refuses a label, and says which in words of its own. */
class Refusing extends Base {
  override readonly resources = ['refusing'];

  override async validate(_type: string, config: Record<string, unknown>): Promise<void> {
    throw new Error(`label "${String(config.label)}" is refused`);
  }
}

/** Refuses what a data block gives, and reads back something else. */
class Reader extends Base {
  override readonly dataSources = ['reader'];

  override async validateDataSource(_type: string, config: Record<string, unknown>): Promise<void> {
    throw new Error(`content "${String(config.content)}" is refused`);
  }
}

class Altering extends Base {
  override readonly dataSources = ['altering'];

  override async readDataSource(): Promise<Record<string, unknown>> {
    return { content: 'other' };
  }
}

describe('an error about a resource, given a sensitive value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for (const provider of [new Loud(), new Wrong(), new WrongOnSecret(), new PlanThrowing(), new Shouting(), new Refusing(), new Reader(), new Altering()])
      engine.registerProvider(provider);
    return engine;
  };

  const failureOf = async (config: string) => {
    const engine = newOrchestrator();
    const failures: string[] = [];
    for await (const event of engine.runPlan(await engine.plan(config), config)) if (event.type === 'failed') failures.push(event.error.message);
    return failures;
  };

  const planFails = async (run: (engine: Orchestrator) => Promise<unknown>) => {
    try {
      await run(newOrchestrator());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('planned');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-errors-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('what the provider returns at apply', () => {
    it('hides the value and keeps the attribute, and shows the rest', async () => {
      expect(await failureOf(`${MODULE}resource "loud" "a" { label = module.db.secret }`)).toEqual([
        'loud returned what the plan did not show, which is a bug in the provider:\n  label: inconsistent values for sensitive attribute\n  volume = "high", which the plan did not have',
      ]);
    });

    it('shows both values where nothing is sensitive', async () => {
      expect(await failureOf('resource "loud" "a" { label = "hunter2" }')).toEqual([
        'loud returned what the plan did not show, which is a bug in the provider:\n  label = "HUNTER2", where the plan showed "hunter2"\n  volume = "high", which the plan did not have',
      ]);
    });
  });

  describe('what the provider plans', () => {
    it('hides a value planned other than the configuration sets', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}resource "wrong" "a" { label = module.db.secret }`));

      expect(message).toContain('wrong planned label: inconsistent values for sensitive attribute');
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('other');
    });

    it('shows both values where nothing is sensitive', async () => {
      const message = await planFails((engine) => engine.plan('resource "wrong" "a" { label = "hunter2" }'));

      expect(message).toContain('wrong planned label = "other", but the configuration sets "hunter2"');
    });
  });

  const applied = async (config: string) => {
    const engine = newOrchestrator();
    for await (const event of engine.runPlan(await engine.plan(config), config)) if (event.type === 'failed') throw event.error;
  };

  describe('a resource that is updated', () => {
    const FAILED = 'failed on its configuration; a value given to it is sensitive, so the reason is not shown';

    it('hides a value the provider plans other than the configuration sets', async () => {
      await applied('resource "wrong_on_secret" "a" { label = "start" }');

      const message = await planFails((engine) => engine.plan(`${MODULE}resource "wrong_on_secret" "a" { label = module.db.secret }`));

      expect(message).toContain('wrong_on_secret planned label: inconsistent values for sensitive attribute');
      expect(message).not.toContain('hunter2');
    });

    it('hides what the provider throws from its plan', async () => {
      await applied('resource "plan_throwing" "a" { label = "start" }');

      const message = await planFails((engine) => engine.plan(`${MODULE}resource "plan_throwing" "a" { label = module.db.secret }`));

      expect(message).toContain(`plan_throwing ${FAILED}`);
      expect(message).not.toContain('hunter2');
    });
  });

  describe('what the provider says of a value', () => {
    it('hides what the provider throws from its plan, when it creates', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}resource "plan_throwing" "a" { label = module.db.secret }`));

      expect(message).toContain('plan_throwing failed on its configuration; a value given to it is sensitive, so the reason is not shown');
      expect(message).not.toContain('hunter2');
    });

    it('shows what the provider throws from its plan where nothing is sensitive', async () => {
      const message = await planFails((engine) => engine.plan('resource "plan_throwing" "a" { label = "hunter2" }'));

      expect(message).toContain('label "hunter2" cannot be planned');
    });

    it('hides what a provider throws that is not an Error', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}resource "shouting" "a" { label = module.db.secret }`));

      expect(message).toContain('shouting failed on its configuration; a value given to it is sensitive, so the reason is not shown');
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason when a value given to a resource is sensitive', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}resource "refusing" "a" { label = module.db.secret }`));

      expect(message).toContain('refusing failed on its configuration; a value given to it is sensitive, so the reason is not shown');
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of a provider that quotes a number', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}resource "random_string" "id" { length = module.db.size }`));

      expect(message).toContain('random_string failed on its configuration; a value given to it is sensitive, so the reason is not shown');
      expect(message).not.toContain('424242.5');
    });

    it('shows the reason where nothing given is sensitive', async () => {
      const message = await planFails((engine) => engine.plan('resource "random_string" "id" { length = 424242.5 }'));

      expect(message).toContain('random_string "length": 424242.5 is not a whole number');
    });

    it('hides the reason of a data source, when it is read and when it is checked', async () => {
      const config = `${MODULE}data "reader" "r" { content = module.db.secret }`;
      const sentence = 'reader failed on its configuration; a value given to it is sensitive, so the reason is not shown';

      expect(await planFails((engine) => engine.plan(config))).toContain(sentence);
      expect(await planFails((engine) => engine.validate(config))).toContain(sentence);
      expect(await planFails((engine) => engine.plan(config))).not.toContain('hunter2');
    });

    it('shows the reason of a data source where nothing given is sensitive', async () => {
      expect(await planFails((engine) => engine.plan('data "reader" "r" { content = "hunter2" }'))).toContain('content "hunter2" is refused');
    });
  });

  describe('what a data source reads back', () => {
    it('hides a value read other than the configuration gave', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}data "altering" "r" { content = module.db.secret }`));

      expect(message).toContain('content: inconsistent values for sensitive attribute');
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('other');
    });

    it('shows both values where nothing is sensitive', async () => {
      const message = await planFails((engine) => engine.plan('data "altering" "r" { content = "hunter2" }'));

      expect(message).toContain('content = "other", where the configuration gave "hunter2"');
    });
  });

  describe('what the plan showed against what a value comes to at apply', () => {
    const config = `${MODULE}resource "loud" "a" { label = module.db.secret }`;

    const changed = async (before: string, after: string) => {
      const engine = newOrchestrator();
      await fs.writeFile(path.join(dir, 'db', 'main.clay'), before, 'utf8');
      const plan = await engine.plan(config);
      await fs.writeFile(path.join(dir, 'db', 'main.clay'), after, 'utf8');

      const failures: string[] = [];
      for await (const event of engine.runPlan(plan, config)) if (event.type === 'failed') failures.push(event.error.message);
      return failures;
    };

    const HIDDEN = ['the plan showed label, which is sensitive, but it now comes to another value. Plan again.'];

    it('names the attribute and hides both values', async () => {
      expect(await changed(outputOf('hunter2', true), outputOf('hunter3', true))).toEqual(HIDDEN);
    });

    it('hides them where the plan held the value sensitive and it is not now', async () => {
      expect(await changed(outputOf('hunter2', true), outputOf('hunter3', false))).toEqual(HIDDEN);
    });

    it('hides them where the plan held the value plain and it is sensitive now', async () => {
      expect(await changed(outputOf('hunter2', false), outputOf('hunter3', true))).toEqual(HIDDEN);
    });

    it('shows both values where nothing is sensitive', async () => {
      const engine = newOrchestrator();
      const open = 'module "db" { source = "./db" }\nresource "loud" "a" { label = module.db.open }';
      await fs.writeFile(path.join(dir, 'db', 'main.clay'), 'output "open" { value = "hunter2" }', 'utf8');
      const plan = await engine.plan(open);
      await fs.writeFile(path.join(dir, 'db', 'main.clay'), 'output "open" { value = "hunter3" }', 'utf8');

      const failures: string[] = [];
      for await (const event of engine.runPlan(plan, open)) if (event.type === 'failed') failures.push(event.error.message);
      expect(failures).toEqual(['the plan showed label = "hunter2", but it now comes to "hunter3". Plan again.']);
    });
  });
});

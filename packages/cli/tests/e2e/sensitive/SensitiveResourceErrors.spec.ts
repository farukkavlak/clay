import { CreateRequest, Identity, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, STATE_VERSION, types, UpdateRequest } from '@clay/contracts';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestratorIn, TestEngine } from '../helpers';

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

const hidden = (doing: string) => `failed ${doing}; a value given to it is sensitive, so the reason is not shown`;
const secretIn = (type: string) => `${MODULE}resource "${type}" "a" { label = module.db.secret }`;

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

  async delete(_type: string, _prior: Record<string, unknown>): Promise<void> {}

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

/** Throws at apply, quoting the label it was given or holds. */
class Throwing extends Base {
  override readonly resources = ['throwing'];
  override readonly dataSources = ['throwing'];

  override async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    throw new Error(`label "${String(config.label)}" cannot be created`);
  }

  override async update(_type: string, { prior, config }: UpdateRequest): Promise<Record<string, unknown>> {
    throw new Error(`label "${String(prior.label)}" cannot be updated to "${String(config.label)}"`);
  }

  override async readDataSource(_type: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    throw new Error(`content "${String(config.content)}" cannot be read`);
  }
}

/** Throws when it destroys or reads back what it holds, quoting the label. */
class Holding extends Base {
  override readonly resources = ['holding'];
  failRead = false;
  failIdentify = false;

  failPlan = false;

  async identify(_type: string, values: Record<string, unknown>): Promise<Identity> {
    if (this.failIdentify && SECRET(values.label)) throw new Error(`label "${String(values.label)}" cannot be identified`);
    return { key: `holding ${String(values.label)}`, name: String(values.label) };
  }

  override async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    if (this.failPlan && request.prior) throw new Error(`label "${String(request.prior.label)}" cannot be planned from`);
    return super.plan(type, request);
  }

  override async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (this.failRead) throw new Error(`label "${String(prior.label)}" cannot be read`);
    return prior;
  }

  override async delete(_type: string, prior: Record<string, unknown>): Promise<void> {
    throw new Error(`label "${String(prior.label)}" cannot be destroyed`);
  }
}

describe('an error about a resource, given a sensitive value', () => {
  let dir: string;
  let holding: Holding;

  const newOrchestrator = () => {
    const engine = orchestratorIn(dir, new LocalProvider());
    for (const provider of [
      new Loud(),
      new Wrong(),
      new WrongOnSecret(),
      new PlanThrowing(),
      new Shouting(),
      new Refusing(),
      new Reader(),
      new Altering(),
      new Throwing(),
      holding,
    ])
      engine.registerProvider(provider);
    return engine;
  };

  const failureOf = async (config: string) => {
    const engine = newOrchestrator();
    const failures: string[] = [];
    for await (const event of engine.runPlan(await engine.plan(config), config)) if (event.type === 'failed') failures.push(event.error.message);
    return failures;
  };

  const applied = async (config: string) => {
    const engine = newOrchestrator();
    for await (const event of engine.runPlan(await engine.plan(config), config)) if (event.type === 'failed') throw event.error;
  };

  const planFails = async (run: (engine: TestEngine) => Promise<unknown>) => {
    try {
      await run(newOrchestrator());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('planned');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-errors-'));
    holding = new Holding();
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

  describe('what the provider throws at apply', () => {
    it('hides the reason of a create', async () => {
      const failures = await failureOf(secretIn('throwing'));

      expect(failures.join('\n')).toContain(`throwing ${hidden('to create')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('shows the reason of a create where nothing given is sensitive', async () => {
      const failures = await failureOf('resource "throwing" "a" { label = "hunter2" }');

      expect(failures.join('\n')).toContain('label "hunter2" cannot be created');
    });

    it('hides the reason of an update', async () => {
      const state: State = { version: STATE_VERSION, serial: 0, resources: { 'throwing.a': { resourceType: 'throwing', name: 'a', attributes: { label: 'start' } } } };
      await new LocalBackend(dir).write(state);

      const failures = await failureOf(secretIn('throwing'));

      expect(failures.join('\n')).toContain(`throwing ${hidden('to update')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of an update from what the state holds sensitive', async () => {
      const resource = { resourceType: 'throwing', name: 'a', attributes: { label: 'hunter2' }, sensitive: [['label']] };
      await new LocalBackend(dir).write({ version: STATE_VERSION, serial: 0, resources: { 'throwing.a': resource } });

      const failures = await failureOf('resource "throwing" "a" { label = "start" }');

      expect(failures.join('\n')).toContain(`throwing ${hidden('to update')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of a destroy of what holds a sensitive value', async () => {
      await applied(secretIn('holding'));

      const failures = await failureOf('');

      expect(failures.join('\n')).toContain(`holding ${hidden('to destroy')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of a destroy of a deposed object that holds a sensitive value', async () => {
      const state: State = {
        version: STATE_VERSION,
        serial: 0,
        resources: {},
        deposed: { 'holding.a': [{ attributes: { label: 'hunter2' }, sensitive: [['label']] }] },
      };
      await new LocalBackend(dir).write(state);

      const failures = await failureOf('');

      expect(failures.join('\n')).toContain(`holding ${hidden('to destroy')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of a read back of what holds a sensitive value', async () => {
      await applied(secretIn('holding'));
      holding.failRead = true;

      const message = await planFails((engine) => engine.plan(secretIn('holding')));

      expect(message).toContain(`holding ${hidden('to read')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of an identify of what the plan makes', async () => {
      holding.failIdentify = true;

      const message = await planFails((engine) => engine.plan(secretIn('holding')));

      expect(message).toContain(`holding ${hidden('to identify')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of an identify of what the plan destroys', async () => {
      await applied(secretIn('holding'));
      holding.failIdentify = true;

      const message = await planFails((engine) => engine.plan(''));

      expect(message).toContain(`holding ${hidden('to identify')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of an identify at apply', async () => {
      const engine = newOrchestrator();
      const plan = await engine.plan(secretIn('holding'));
      holding.failIdentify = true;

      const failures: string[] = [];
      for await (const event of engine.runPlan(plan, secretIn('holding'))) if (event.type === 'failed') failures.push(event.error.message);

      expect(failures.join('\n')).toContain(`holding ${hidden('to identify')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of an identify of what the state holds, at the apply of another', async () => {
      await applied(secretIn('holding'));
      const config = `${secretIn('holding')}\nresource "holding" "b" { label = "start" }`;
      const engine = newOrchestrator();
      const plan = await engine.plan(config);
      holding.failIdentify = true;

      const failures: string[] = [];
      for await (const event of engine.runPlan(plan, config)) if (event.type === 'failed') failures.push(event.error.message);

      expect(failures.join('\n')).toContain(`holding ${hidden('to identify')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
    });

    it('hides the reason of an identify of a deposed object the plan destroys', async () => {
      const state: State = {
        version: STATE_VERSION,
        serial: 0,
        resources: {},
        deposed: { 'holding.a': [{ attributes: { label: 'hunter2' }, sensitive: [['label']] }] },
      };
      await new LocalBackend(dir).write(state);
      holding.failIdentify = true;

      const message = await planFails((engine) => engine.plan(''));

      expect(message).toContain(`holding ${hidden('to identify')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of a plan from what the state holds sensitive', async () => {
      await applied(secretIn('holding'));
      holding.failPlan = true;

      const message = await planFails((engine) => engine.plan('resource "holding" "a" { label = "start" }'));

      expect(message).toContain(`holding ${hidden('on its configuration')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the reason of a data source read', async () => {
      const message = await planFails((engine) => engine.plan(`${MODULE}data "throwing" "r" { content = module.db.secret }`));

      expect(message).toContain(`throwing ${hidden('to read')}`);
      expect(message).not.toContain('hunter2');
    });

    it('hides the command of a command_exec that fails', async () => {
      const failures = await failureOf(`${MODULE}resource "command_exec" "c" { command = "false \${module.db.secret}" }`);

      expect(failures.join('\n')).toContain(`command_exec ${hidden('to create')}`);
      expect(failures.join('\n')).not.toContain('hunter2');
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

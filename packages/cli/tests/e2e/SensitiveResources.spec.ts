import { EVERY_ITEM, ExactNumber, State, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DB = `
  resource "random_string" "s" { length = 8 }
  output "password" {
    value     = "hunter2"
    sensitive = true
  }
  output "made" {
    value     = random_string.s.result
    sensitive = true
  }
`;

const REFUSED = 'output "probe" holds a sensitive value; write sensitive = true to export it';
const TRIGGERS = [
  ['triggers', 'token'],
  ['triggers', 'list', 1],
];
const READ = '\noutput "probe" { value = local_file.conf.content }';
const EACH = 'for_each is sensitive: a key shows in an address, so it cannot be hidden';

const shown = (value: unknown) => (typeof value === 'string' ? path.basename(value) : value);

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

const sensitiveOf = (plan: Awaited<ReturnType<Orchestrator['plan']>>) => plan.actions.find((action) => action.resourceType === 'null_resource')?.sensitive;

describe('a resource given a sensitive value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const file = (name: string, content: string, repeat = '') => `
    resource "local_file" "${name}" {${repeat}
      path    = "${path.join(dir, name)}${repeat === '' ? '' : '-${' + (repeat.includes('count') ? 'count.index' : 'each.key') + '}'}.txt"
      content = ${content}
    }
  `;

  const resources = () => `
    module "db" { source = "./db" }
    ${file('conf', '"password=${module.db.password}"')}
    ${file('made', 'module.db.made')}
    ${file('logs', 'module.db.password', '\n      count = 2')}
    ${file('each', 'module.db.password', '\n      for_each = toset(["a"])')}
    ${file('plain', '"seen"')}
    resource "null_resource" "n" {
      triggers = { name = "app", token = module.db.password, list = ["a", module.db.password] }
    }
  `;

  const conf = (content: string, output = '') => `module "db" { source = "./db" }\n${file('conf', content)}${output}`;

  const reading = (content: string) => `${conf(content)}\ndata "local_file" "r" { path = local_file.conf.id }`;

  const probe = (value: string, flag = '') => `${resources()}\noutput "probe" {\n  value = ${value}${flag}\n}`;

  const apply = async (config: string) => {
    const engine = newOrchestrator();
    await drain(engine.runPlan(await engine.plan(config), config));
  };

  const held = async (address: string) => {
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;

    return state.resources[address];
  };

  const marks = async (address: string) => {
    const resource = await held(address);

    return resource.sensitive;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-resources-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const READS = [
    ['the attribute it was given to', 'local_file.conf.content'],
    ['the whole resource', 'local_file.conf'],
    ['the attribute it was given to, known only after apply', 'local_file.made.content'],
    ['one key of a map it was given in', 'null_resource.n.triggers.token'],
    ['one item of a list in a map it was given in', 'null_resource.n.triggers.list[1]'],
    ['the map it was given in', 'null_resource.n.triggers'],
    ['every instance of a resource with count', 'local_file.logs'],
    ['one instance of a resource with count', 'local_file.logs[1].content'],
    ['every instance of a resource with for_each', 'local_file.each'],
    ['one instance of a resource with for_each', 'local_file.each["a"].content'],
  ];

  it.each(READS)('makes sensitive %s, read from its plan', async (_, value) => {
    await expect(newOrchestrator().plan(probe(value))).rejects.toThrow(REFUSED);
    await expect(newOrchestrator().validate(probe(value))).rejects.toThrow(REFUSED);
  });

  it.each(READS)('makes sensitive %s, read from the state', async (_, value) => {
    await apply(resources());

    await expect(newOrchestrator().plan(probe(value))).rejects.toThrow(REFUSED);
    await expect(newOrchestrator().plan(probe(value), { refresh: false })).rejects.toThrow(REFUSED);
  });

  const SHOWN: [string, string, unknown][] = [
    ['another attribute of the resource', 'local_file.conf.id', 'conf.txt'],
    ['another key of the map it was given in', 'null_resource.n.triggers.name', 'app'],
    ['another item of a list in the map it was given in', 'null_resource.n.triggers.list[0]', 'a'],
    ['how many instances a resource with count has', 'length(local_file.logs)', ExactNumber.parse('2')],
    ['a resource given none', 'local_file.plain.content', 'seen'],
  ];

  it.each(SHOWN)('leaves %s to be shown, read from its plan and from the state', async (_, value, data) => {
    const planned = await newOrchestrator().plan(probe(value));
    await apply(resources());
    const again = await newOrchestrator().plan(probe(value));

    expect(shown(planned.outputs.probe.new?.value)).toEqual(data);
    expect(shown(again.outputs.probe.new?.value)).toEqual(data);
  });

  it('is exported by a root output that says it is sensitive', async () => {
    const { outputs } = await newOrchestrator().plan(probe('local_file.conf.content', '\n  sensitive = true'));

    expect(outputs.probe.new).toMatchObject({ value: 'password=hunter2', sensitive: true });
  });

  it('refuses a for_each whose key is the attribute', async () => {
    const config = `${resources()}\n${file('copies', 'each.key', '\n      for_each = toset([local_file.conf.content])')}`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow(EACH);
    await expect(newOrchestrator().validate(config)).rejects.toThrow(EACH);
  });

  it('keeps in the state which parts of a resource are sensitive, and nothing for a resource with none', async () => {
    await apply(resources());

    expect(await marks('local_file.conf')).toEqual([['content']]);
    expect(await marks('local_file.logs[1]')).toEqual([['content']]);
    expect(await marks('null_resource.n')).toEqual(TRIGGERS);
    expect(await held('local_file.plain')).not.toHaveProperty('sensitive');
  });

  it('is sensitive in a resource that reads it from another at apply', async () => {
    const config = `${resources()}\n${file('copy', 'local_file.made.content')}`;
    await apply(config);

    expect(await marks('local_file.copy')).toEqual([['content']]);
  });

  it('stays sensitive in a resource changed outside Clay', async () => {
    await apply(resources());
    await fs.writeFile(path.join(dir, 'conf.txt'), 'changed', 'utf8');

    await expect(newOrchestrator().plan(probe('local_file.conf.content'))).rejects.toThrow(REFUSED);
    await apply(resources());
    expect(await marks('local_file.conf')).toEqual([['content']]);
  });

  it.each([
    ['becomes sensitive', '"hunter2"', 'module.db.password', [['content']]],
    ['is sensitive no more', 'module.db.password', '"hunter2"', undefined],
  ])('writes to the state that a value %s, where the value is the same', async (_, before, after, sensitive) => {
    await apply(conf(before));
    await apply(conf(after));

    expect(await marks('local_file.conf')).toEqual(sensitive);
  });

  it.each([
    ['becomes sensitive', '"seen"', 'module.db.password', [['content']]],
    ['is sensitive no more', 'module.db.password', '"seen"', undefined],
  ])('writes to the state that a value %s, where the value changes too', async (_, before, after, sensitive) => {
    await apply(conf(before));
    await apply(conf(after));

    expect(await marks('local_file.conf')).toEqual(sensitive);
  });

  it('reads a data source at plan where the resource it reads changes only in which parts are sensitive', async () => {
    await apply(reading('"hunter2"'));

    const marksOnly = await newOrchestrator().plan(reading('module.db.password'));
    const value = await newOrchestrator().plan(reading('"changed"'));

    expect(marksOnly.readAtApply).toEqual([]);
    expect(value.readAtApply).toEqual(['data.local_file.r']);
  });

  it('keeps a value sensitive through a replace, read from its plan and from the state', async () => {
    await apply(conf('module.db.password'));
    const moved = conf('module.db.password').replace('conf.txt', 'moved.txt');

    await expect(newOrchestrator().plan(moved + READ)).rejects.toThrow(REFUSED);
    await apply(moved);
    expect(await marks('local_file.conf')).toEqual([['content']]);
  });

  describe('given a for over a list not known yet', () => {
    const rows = '[for v in tolist(toset([random_string.r.result])) : { name = v, token = module.db.password }]';
    const config = `module "db" { source = "./db" }\nresource "random_string" "r" { length = 8 }\nresource "null_resource" "n" {\n  triggers = { rows = ${rows} }\n}`;
    const itemsOnly = [['triggers', 'rows', EVERY_ITEM]];

    it('marks every item in the plan, and the parts the apply finds sensitive in the state', async () => {
      const engine = newOrchestrator();
      const plan = await engine.plan(config);
      await drain(engine.runPlan(plan, config));

      expect(sensitiveOf(plan)).toEqual(itemsOnly);
      expect(await marks('null_resource.n')).toEqual([['triggers', 'rows', 0, 'token']]);
    });

    it.each([
      ['whose body ignores the item', '[for r in null_resource.n.triggers.rows : "x"]', true],
      ['whose body reads the item', '[for r in null_resource.n.triggers.rows : r.name]', false],
    ])('marks each item of a for over what it marks every item of, %s', async (_, value, accepted) => {
      const probe = `${config}\noutput "probe" { value = ${value} }`;

      if (accepted) {
        const { outputs } = await newOrchestrator().plan(probe);
        expect(outputs.probe.new?.value).toBe(UNKNOWN);
      } else await expect(newOrchestrator().plan(probe)).rejects.toThrow(REFUSED);
    });

    it('keeps the mark of every item through a plan saved to a file', async () => {
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
      await drain(newOrchestrator().runPlan(saved, config));

      expect(sensitiveOf(saved)).toEqual(itemsOnly);
      expect(await marks('null_resource.n')).toEqual([['triggers', 'rows', 0, 'token']]);
    });
  });

  it('reads the value as the configuration marks it now, not as the state does', async () => {
    await apply(conf('module.db.password'));

    const { outputs } = await newOrchestrator().plan(conf('"hunter2"', READ));
    expect(outputs.probe.new?.value).toBe('hunter2');

    await apply(conf('"hunter2"', READ));
    await expect(newOrchestrator().plan(conf('module.db.password', READ))).rejects.toThrow(REFUSED);
  });

  it('keeps which parts are sensitive through a plan saved to a file', async () => {
    const config = resources();
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
    await drain(newOrchestrator().runPlan(saved, config));

    expect(await marks('local_file.conf')).toEqual([['content']]);
    expect(await marks('null_resource.n')).toEqual(TRIGGERS);
  });

  it('keeps a plan saved after an apply, with what the state marks', async () => {
    const config = resources();
    await apply(config);
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
    await drain(newOrchestrator().runPlan(saved, config));

    expect(await marks('null_resource.n')).toEqual(TRIGGERS);
  });
});

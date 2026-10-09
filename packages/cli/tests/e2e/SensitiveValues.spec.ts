import { ExactNumber } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
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
  output "name" { value = "app" }
  output "password_list" {
    value     = ["hunter2"]
    sensitive = true
  }
  output "made_set" {
    value     = toset([random_string.s.result])
    sensitive = true
  }
  output "empty" {
    value     = {}
    sensitive = true
  }
  output "nothing" {
    value     = null
    sensitive = true
  }
  output "keyed" {
    value     = { hunter2 = "x" }
    sensitive = true
  }
`;

const APP = `
  variable "conn" { type = object({ name = string, password = string }) }
  variable "members" { type = set(string) }
  variable "made" { type = string }
  variable "filled" { type = object({ a = optional(string) }) }
  variable "rows" { type = set(object({ a = string, b = optional(string) })) }
  output "made" { value = var.made }
  output "filled" { value = var.filled }
  output "rows" { value = length(var.rows) }
  output "name" { value = var.conn.name }
  output "password" { value = var.conn.password }
  output "size" { value = length(var.members) }
`;

const ECHO = `
  variable "v" { type = string }
  output "v" { value = var.v }
`;

const TAKES = `
  variable "on" {
    type    = bool
    default = true
  }
  variable "named" {
    type    = object({ a = optional(string) })
    default = {}
  }
`;

const REP = `
  variable "v" { type = any }
  output "o" { value = var.v }
`;

const UNJOINED = 'cannot join what it holds into one type; a part of it is sensitive, so no more is shown';

const QUOTED = [
  [
    'a key two items of a for give',
    'output "probe" {\n  value = length({ for v in ["a", "b"] : module.db.password => v })\n  sensitive = true\n}',
    'Two items give the key (sensitive value);',
  ],
  [
    'a key an item that is not sensitive gives too',
    'output "probe" {\n  value = length({ for v in [module.db.password, "hunter2"] : v => 1 })\n  sensitive = true\n}',
    'Two items give the key (sensitive value);',
  ],
  ['a string where a resource takes a number', 'resource "random_string" "x" { length = module.db.password }', 'length: (sensitive value) is not a number'],
  [
    'a string where a variable takes a boolean',
    'module "takes" {\n  source = "./takes"\n  on = module.db.password\n}',
    'on: (sensitive value) is not a boolean, which is "true" or "false"',
  ],
  [
    'a key the type of a variable does not have',
    'module "takes" {\n  source = "./takes"\n  named = module.db.keyed\n}',
    'named does not fit what variable "named" takes; it is sensitive, so its parts are not shown',
  ],
  ['a key that keeps tolist from joining its items', 'output "probe" {\n  value = tolist([{ a = "x" }, module.db.keyed])\n  sensitive = true\n}', `tolist ${UNJOINED}`],
  [
    'a key that keeps the instances of a module from sharing a type',
    'module "rep" {\n  source = "./rep"\n  for_each = { a = module.db.keyed, b = { z = 1 } }\n  v = each.value\n}\noutput "probe" {\n  value = module.rep\n  sensitive = true\n}',
    `module.rep ${UNJOINED}`,
  ],
].map(([name, written, message]) => [name, `module "db" { source = "./db" }\n${written}`, message]);

type Block = [name: string, write: (repeat: string) => string];

const BLOCKS: Block[] = [
  ['a resource', (repeat) => `resource "local_file" "a" {\n  ${repeat}\n  path = "a.txt"\n  content = "x"\n}`],
  ['a data source', (repeat) => `data "local_file" "f" {\n  ${repeat}\n  path = "a.txt"\n}`],
  ['a module call', (repeat) => `module "echo" {\n  source = "./echo"\n  ${repeat}\n  v = "x"\n}`],
];

const EACH = 'for_each is sensitive: a key shows in an address, so it cannot be hidden';
const COUNT = 'count is sensitive: the number of instances shows what it is';

const REPEATS = [
  ['for_each', 'for_each = toset([module.db.password])', EACH],
  ['for_each with a member known only after apply', 'for_each = module.db.made_set', EACH],
  ['for_each known only after apply', 'for_each = tolist(module.db.made_set)', EACH],
  ['count', 'count = length(module.db.password_list)', COUNT],
  ['count known only after apply', 'count = length(module.db.made)', COUNT],
];

const REPEATED = REPEATS.flatMap(([name, repeat, message]) =>
  BLOCKS.map(([block, write]) => [`${block} with a sensitive ${name}`, `module "db" { source = "./db" }\n${write(repeat)}`, message])
);

const eachValue = (flag: string) => `
  module "db" { source = "./db" }
  module "echo" {
    source   = "./echo"
    for_each = { primary = module.db.password }
    v        = each.value
  }
  output "probe" {
    value = module.echo["primary"].v${flag}
  }
`;

const probe = (value: string, flag = '') => `
  resource "random_string" "r" { length = 8 }
  module "db" { source = "./db" }
  module "app" {
    source  = "./app"
    conn    = { name = "app", password = module.db.password }
    members = ["a", module.db.password]
    made    = module.db.made
    filled  = module.db.empty
    rows    = toset([{ a = module.db.password }])
  }
  locals {
    conn = { name = "app", password = module.db.password }
    made = { name = "app", password = module.db.made }
  }
  output "probe" {
    value = ${value}${flag}
  }
`;

const refused = (error: Error) => error.message;

const REFUSED = 'output "probe" holds a sensitive value; write sensitive = true to export it';

const n = (text: string) => ExactNumber.parse(text);

describe('a sensitive value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const planned = async (value: string, flag = '') => {
    const { outputs } = await newOrchestrator().plan(probe(value, flag));
    return outputs.probe.new;
  };

  const run = async (config: string) => {
    const engine = newOrchestrator();
    for await (const event of engine.runPlan(await engine.plan(config), config)) if (event.type === 'failed') throw event.error;
  };

  const writeModule = async (name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), content, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-values-'));
    await writeModule('db', DB);
    await writeModule('app', APP);
    await writeModule('echo', ECHO);
    await writeModule('takes', TAKES);
    await writeModule('rep', REP);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['is read from the module that marks it', 'module.db.password'],
    ['is one output of a whole module instance', 'module.db'],
    ['is joined into a string', '"pg://${module.db.password}@h"'],
    ['is read from a local, by the step that reaches it', 'local.conn.password'],
    ['is one part of a local read whole', 'local.conn'],
    ['is an item of a list', '["a", module.db.password]'],
    ['is an item of what tolist gives', 'tolist(["a", module.db.password])'],
    ['is a member of a set', 'toset(["a", module.db.password])'],
    ['is a member of a set whose size is read', 'length(toset(["a", module.db.password]))'],
    ['is a string whose length is read', 'length(module.db.password)'],
    ['is what the body of a for gives', '[for v in ["a"] : module.db.password]'],
    ['is a value in the object a for makes', '{ for k, v in local.conn : k => v }'],
    ['is a key of the object a for makes, whose size is read', 'length({ for k, v in local.conn : v => k })'],
    ['is the list a for goes over', '[for v in module.db.password_list : "x"]'],
    ['is the list a for goes over, to make an object with a key known only after apply', '{ for v in module.db.password_list : random_string.r.result => "x" }'],
    ['is given to a module, which gives it back by a step into its variable', 'module.app.password'],
    ['is a member of a set a module takes, whose size it gives', 'module.app.size'],
    ['is known only after apply', 'module.db.made'],
    ['is known only after apply and joined into a string', '"pg://${module.db.made}@h"'],
    ['is known only after apply and read from a local', 'local.made.password'],
    ['is known only after apply and is what tolist is given', 'tolist(module.db.made_set)'],
    ['is known only after apply and given to a module, which gives it back', 'module.app.made'],
    ['is known only after apply and is a key of the object a for makes', '{ for k, v in local.made : v => k }'],
    ['is a set a for goes over, with a member known only after apply', '[for v in module.db.made_set : "x"]'],
    ['is a list a for goes over, known only after apply', '[for v in tolist(module.db.made_set) : "x"]'],
    ['is null of no type and given to tolist', 'tolist(module.db.nothing)'],
    ['is an empty object a module takes with an attribute left out', 'module.app.filled'],
    ['is a set a module takes with an attribute left out of each member, whose size it gives', 'module.app.rows'],
  ])('is refused in a root output that does not say so, where it %s', async (_, value) => {
    await expect(newOrchestrator().plan(probe(value))).rejects.toThrow(REFUSED);
    await expect(newOrchestrator().validate(probe(value))).rejects.toThrow(REFUSED);
  });

  it.each([
    ['another part of the object that holds it', 'local.conn.name', 'app'],
    ['another output of the module that marks it', 'module.db.name', 'app'],
    ['the size of an object that holds it', 'length(local.conn)', n('2')],
    ['the size of a list that holds it', 'length(["a", module.db.password])', n('2')],
    ['another item of what tolist gives', 'tolist(["a", module.db.password])[0]', 'a'],
    ['the keys of an object that holds it', '[for k, v in local.conn : k]', ['name', 'password']],
    ['another part of each item a for goes over', '[for v in [local.conn] : v.name]', ['app']],
    ['another part of the object a module was given it in', 'module.app.name', 'app'],
    ['another part of an object that holds one known only after apply', 'local.made.name', 'app'],
  ])('leaves %s to be shown', async (_, value, data) => {
    const shown = await planned(value);

    expect(shown?.value).toEqual(data);
  });

  it('is exported by a root output that says it is sensitive', async () => {
    expect(await planned('local.conn', '\n    sensitive = true')).toMatchObject({ value: { name: 'app', password: 'hunter2' }, sensitive: true });
  });

  it.each(QUOTED)('is not quoted by the error about %s', async (_, config, expected) => {
    for (const check of ['plan', 'validate'] as const) {
      const message = await newOrchestrator()
        [check](config)
        .then(() => 'accepted', refused);

      expect(message).toContain(expected);
      expect(message).not.toContain('hunter2');
    }
  });

  it.each(REPEATED)('refuses %s', async (_, config, message) => {
    await expect(newOrchestrator().plan(config)).rejects.toThrow(message);
    await expect(newOrchestrator().validate(config)).rejects.toThrow(message);
  });

  it('is taken as a value of a for_each whose keys are not sensitive, and each.value stays sensitive', async () => {
    await expect(newOrchestrator().plan(eachValue(''))).rejects.toThrow(REFUSED);

    const { outputs } = await newOrchestrator().plan(eachValue('\n    sensitive = true'));
    expect(outputs.probe.new).toMatchObject({ value: 'hunter2', sensitive: true });
  });

  // The plan cannot read the body of a for over a set with no order yet, so only the apply finds the value.
  it('is refused at apply where only the apply reads it, and is not written to the state', async () => {
    await expect(run(probe('[for v in toset([random_string.r.result]) : module.db.password]'))).rejects.toThrow(REFUSED);
    await expect(fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')).resolves.not.toContain('"probe"');
  });
});

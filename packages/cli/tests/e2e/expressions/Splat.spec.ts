import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../start';

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const servers = `variable "servers" {
  default = [
    { name = "web", port = 80, disks = [10, 20] },
    { name = "api", port = 443, disks = [30] },
  ]
}`;

const number = (text: string) => ExactNumber.parse(text);

describe('a [*]', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  };

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  const files = (count: number) => `resource "local_file" "f" {
  count   = ${count}
  path    = "${path.join(dir, 'f-${count.index}.txt')}"
  content = "c\${count.index}"
}`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-splat-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives the attribute of each item, in an output', async () => {
    await apply(`${servers}\noutput "ports" { value = var.servers[*].port }`);

    expect(await outputs()).toEqual({ ports: { value: [number('80'), number('443')], type: types.tuple([types.number, types.number]) } });
  });

  it('reads each instance of a resource with count, and a file is made for each', async () => {
    await apply(`${files(2)}\noutput "contents" { value = local_file.f[*].content }`);

    expect(await outputs()).toEqual({ contents: { value: ['c0', 'c1'], type: types.tuple([types.string, types.string]) } });
    expect(await fs.readFile(path.join(dir, 'f-1.txt'), 'utf8')).toBe('c1');
  });

  it('knows how many items there are at plan while each is made by the apply', async () => {
    const config = 'resource "random_string" "s" {\n  count  = 2\n  length = 4\n}\noutput "r" { value = random_string.s[*].result }';

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.r.new).toEqual({ value: [UNKNOWN, UNKNOWN], type: types.tuple([types.string, types.string]) });
    const state = await new LocalBackend(dir).read();
    const held = await outputs();
    expect(held?.r.value).toEqual([0, 1].map((index) => state.resources[`random_string.s[${index}]`].attributes.result));
  });

  it.each([
    ['a [*] after another, as a tuple for each item', 'var.servers[*].disks[*]', [[number('10'), number('20')], [number('30')]]],
    ['an index after it into each item', 'var.servers[*].disks[0]', [number('10'), number('30')]],
    ['an index into what it gives, in parentheses', '(var.servers[*].name)[1]', 'api'],
    ['the members of a set in order', 'toset(["b", "a"])[*]', ['a', 'b']],
    ['a [*] over a value with no name inside the index of another', '[{ a = "x" }][*][(["a"][*])[0]]', ['x']],
  ])('reads %s', async (_, value, expected) => {
    await apply(`${servers}\noutput "o" { value = ${value} }`);

    const held = await outputs();
    expect(held?.o.value).toEqual(expected);
  });

  it.each([
    [
      'a resource with for_each',
      'resource "local_file" "g" {\n  for_each = toset(["a"])\n  path     = each.key\n  content  = "x"\n}',
      'local_file.g[*].content',
      'local_file.g',
      'not a map',
    ],
    ['a resource with no count', 'resource "local_file" "g" {\n  path    = "g"\n  content = "x"\n}', 'local_file.g[*].content', 'local_file.g', 'not an object'],
    ['null', 'variable "n" { default = null }', 'var.n[*]', 'var.n', 'not null, and var.n, which it reads, is null'],
    ['a string the apply makes', 'resource "random_string" "s" { length = 4 }', 'random_string.s.result[*]', 'random_string.s.result', 'not a string'],
  ])('refuses %s where it is written, as no list', async (_, block, value, needle, problem) => {
    const config = `${block}\noutput "o" {\n  value = ${value}\n}`;

    const error = await planError(config);

    expect(error.message).toBe(`[*] goes over a list, a tuple or a set, ${problem}`);
    expect(error.position).toMatchObject(placeOf(config, needle));
    expect(error.block).toBe('output "o"');
  });

  it.each([
    ['a key no item has', 'var.servers[*].prot', 'var.servers[*] has no key "prot"'],
    ['a step into what each item gives', 'var.servers[*].port[0]', 'var.servers[*].port is a number and cannot be read into'],
  ])('refuses %s, named as it is written', async (_, value, message) => {
    const config = `${servers}\noutput "o" {\n  value = ${value}\n}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, 'var.servers[*]'));
  });

  it('refuses at validate a step into the items of a list the apply makes', async () => {
    const config = 'resource "random_string" "s" { length = 4 }\noutput "o" {\n  value = tolist(toset([random_string.s.result]))[*].bogus\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'tolist(...)[*] is a string and cannot be read into',
      position: placeOf(config, 'tolist('),
    });
  });

  it('keeps what it reads from a sensitive list sensitive', async () => {
    const config = 'variable "t" {\n  default   = [{ k = "a" }]\n  sensitive = true\n}\noutput "o" { value = var.t[*].k }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('output "o" holds a sensitive value; write sensitive = true to export it');
  });

  it('runs a saved plan whose values it gives', async () => {
    const config = `${files(2)}\noutput "paths" { value = length(local_file.f[*].path) }`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    const held = await outputs();
    expect(held?.paths.value).toEqual(number('2'));
  });
});

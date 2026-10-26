import { types, UNKNOWN } from '@clay/contracts';
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

const names = 'variable "names" { default = ["a", "b"] }';
const random = 'resource "random_string" "s" { length = 4 }';

describe('a for expression', () => {
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

  const textFiles = async () => {
    const found = await fs.readdir(dir);
    return found.filter((name) => name.endsWith('.txt')).sort();
  };

  const result = async () => {
    const state = await new LocalBackend(dir).read();
    return state.resources['random_string.s'].attributes.result as string;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-for-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes an instance for each item it gives', async () => {
    await apply(`${names}
      resource "local_file" "f" {
        for_each = toset([for n in var.names : "app-\${n}"])
        path = "${path.join(dir, '${each.key}.txt')}"
        content = each.value
      }
    `);

    expect(await textFiles()).toEqual(['app-a.txt', 'app-b.txt']);
  });

  it('gives a tuple, in an output', async () => {
    await apply(`${names}\noutput "l" { value = [for i, n in var.names : "\${i}-\${n}"] }`);

    expect(await outputs()).toEqual({ l: { value: ['0-a', '1-b'], type: types.tuple([types.string, types.string]) } });
  });

  it('leaves an item only the apply makes to the apply, and plans the rest', async () => {
    const config = `${random}\noutput "l" { value = [for s in ["z", random_string.s.result] : "x-\${s}"] }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.l.new).toEqual({ value: ['x-z', UNKNOWN], type: types.tuple([types.string, types.string]) });
    expect(await outputs()).toEqual({ l: { value: ['x-z', `x-${await result()}`], type: types.tuple([types.string, types.string]) } });
  });

  it('leaves the whole for to the apply while a member of its set is not known', async () => {
    const config = `${random}\noutput "l" { value = [for s in toset(["z", random_string.s.result]) : s] }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.l.new).toEqual({ value: UNKNOWN, type: types.dynamic });
    const held = await outputs();
    expect(held?.l.value).toEqual([await result(), 'z'].sort());
  });

  // Not known at plan, and true once the string is made.
  const later = 'length(random_string.s.result) == 4';

  it.each([
    ['a condition', `[for x in (${later} ? ["a", "b"] : ["c"]) : x]`, ['a', 'b']],
    ['a condition read with an if', `[for x in (${later} ? ["a", "b"] : ["c"]) : x if x == "a"]`, ['a']],
    ['a condition made into an object', `{ for k, v in (${later} ? { a = "1" } : { a = "2" }) : k => v }`, { a: '1' }],
  ])('leaves the whole for to the apply where %s gives a collection not known yet', async (_, value, expected) => {
    const config = `${random}\noutput "l" { value = ${value} }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.l.new).toEqual({ value: UNKNOWN, type: types.dynamic });
    const held = await outputs();
    expect(held?.l.value).toEqual(expected);
  });

  it.each([
    ['a sensitive condition', `[for x in (sensitive(${later}) ? ["a"] : ["b"]) : x]`],
    ['a sensitive body', `[for x in (${later} ? ["a"] : ["b"]) : sensitive(x)]`],
  ])('keeps the marks of a for over a value not known yet, with %s', async (_, value) => {
    await expect(newOrchestrator().plan(`${random}\noutput "l" { value = ${value} }`)).rejects.toThrow('output "l" holds a sensitive value; write sensitive = true to export it');
  });

  it('refuses a value not known yet that can be no collection, where it is written', async () => {
    const config = `${random}\noutput "l" { value = [for x in (${later} ? 1 : 2) : x] }`;

    const error = await planError(config);

    expect(error.message).toBe('A for goes over a list, a tuple, a set, a map or an object, not a number');
    expect(error.position).toMatchObject(placeOf(config, 'length('));
  });

  it('reads the index of each instance of a resource in its body', async () => {
    await apply(`${names}
      resource "local_file" "f" {
        count = 2
        path = "${path.join(dir, 'f-${count.index}.txt')}"
        content = tolist([for n in var.names : "\${count.index}\${n}"])[1]
      }
    `);

    expect(await fs.readFile(path.join(dir, 'f-0.txt'), 'utf8')).toBe('0b');
    expect(await fs.readFile(path.join(dir, 'f-1.txt'), 'utf8')).toBe('1b');
  });

  it('reads the key and value of each instance of a resource in its body', async () => {
    await apply(`
      resource "local_file" "f" {
        for_each = { x = "1" }
        path = "${path.join(dir, 'f-${each.key}.txt')}"
        content = tolist([for n in ["a"] : "\${each.key}\${each.value}\${n}"])[0]
      }
    `);

    expect(await fs.readFile(path.join(dir, 'f-x.txt'), 'utf8')).toBe('x1a');
  });

  it('gives a data source a value made by a for', async () => {
    await fs.writeFile(path.join(dir, 'b.txt'), 'read', 'utf8');

    await apply(`${names}
      data "local_file" "d" {
        path = tolist([for n in var.names : "${dir}/\${n}.txt"])[1]
      }
      output "read" { value = data.local_file.d.content }
    `);

    const held = await outputs();
    expect(held?.read.value).toBe('read');
  });

  it('refuses a collection it cannot go over where it is written', async () => {
    const config = `${names}\noutput "n" {\n  value = [for n in "ab" : n]\n}`;

    const error = await planError(config);

    expect(error.message).toBe('A for goes over a list, a tuple, a set, a map or an object, not a string');
    expect(error.position).toMatchObject(placeOf(config, '"ab"'));
    expect(error.block).toBe('output "n"');
  });

  it('refuses at plan a collection the apply makes, of a type it cannot go over', async () => {
    const config = `${random}\noutput "l" {\n  value = [for c in random_string.s.result : c]\n}`;

    const error = await planError(config);

    expect(error.message).toBe('A for goes over a list, a tuple, a set, a map or an object, not a string');
    expect(error.position).toMatchObject(placeOf(config, 'random_string.s.result :'));
    expect(await textFiles()).toEqual([]);
  });

  it('refuses a name no function has in a body never read, over an empty collection', async () => {
    const config = `${names}\noutput "n" {\n  value = [for n in [] : lenght(n)]\n}`;

    const error = await planError(config);

    expect(error.message).toBe('There is no function "lenght"');
    expect(error.position).toMatchObject(placeOf(config, 'lenght'));
  });

  it('runs a saved plan whose values read into the items of a for', async () => {
    const config = `variable "v" { default = [["a", "b"], ["c", "d"]] }
      resource "local_file" "f" {
        path = "${path.join(dir, 'f.txt')}"
        content = tolist([for n in var.v : n[1]])[1]
      }
    `;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await fs.readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('d');
  });

  it('gives a module input made by a for to the module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "names" {}\noutput "first" { value = tolist(var.names)[0] }', 'utf8');

    await apply(`${names}\nmodule "m" {\n  source = "./m"\n  names = [for n in var.names : "m-\${n}"]\n}\noutput "first" { value = module.m.first }`);

    const held = await outputs();
    expect(held?.first.value).toBe('m-a');
  });

  describe('that makes an object', () => {
    it('makes an instance for each key it gives, with the value it gives that key', async () => {
      await apply(`${names}
        resource "local_file" "f" {
          for_each = {for n in var.names : "app-\${n}" => "c-\${n}"}
          path = "${path.join(dir, '${each.key}.txt')}"
          content = each.value
        }
      `);

      expect(await textFiles()).toEqual(['app-a.txt', 'app-b.txt']);
      expect(await fs.readFile(path.join(dir, 'app-b.txt'), 'utf8')).toBe('c-b');
    });

    it('gives an object, in an output', async () => {
      await apply(`${names}\noutput "o" { value = {for n in var.names : n => "x-\${n}"} }`);

      expect(await outputs()).toEqual({ o: { value: { a: 'x-a', b: 'x-b' }, type: types.object({ a: types.string, b: types.string }) } });
    });

    it('groups the values of one key, in an output', async () => {
      await apply(`output "o" { value = {for n in ["a", "b", "a"] : n => "x-\${n}"...} }`);

      const held = await outputs();
      expect(held?.o.value).toEqual({ a: ['x-a', 'x-a'], b: ['x-b'] });
    });

    it('leaves a value only the apply makes to the apply, and plans its key', async () => {
      const config = `${random}\noutput "o" { value = {for n in ["k"] : n => random_string.s.result} }`;

      const plan = await newOrchestrator().plan(config);
      await apply(config);

      expect(plan.outputs.o.new).toEqual({ value: { k: UNKNOWN }, type: types.object({ k: types.string }) });
      const held = await outputs();
      expect(held?.o.value).toEqual({ k: await result() });
    });

    it('leaves the whole for to the apply while a key only the apply makes is not known', async () => {
      const config = `${random}\noutput "o" { value = {for n in ["v"] : random_string.s.result => n} }`;

      const plan = await newOrchestrator().plan(config);
      await apply(config);

      expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.dynamic });
      const held = await outputs();
      expect(held?.o.value).toEqual({ [await result()]: 'v' });
    });

    it('refuses a key two items give, where the key is written', async () => {
      const config = `output "o" {\n  value = {for n in ["a", "a"] : n => n}\n}`;

      const error = await planError(config);

      expect(error.message).toBe('Two items give the key "a"; write "..." after the value to group them');
      expect(error.position).toMatchObject(placeOf(config, 'n => n'));
      expect(error.block).toBe('output "o"');
    });

    it('refuses a key of a type no key has before a key two items give', async () => {
      const config = `output "o" {\n  value = {for n in ["a", "a", null] : n => 1}\n}`;

      const error = await planError(config);

      expect(error.message).toBe('A key in a for is a string, a number or a boolean, not null');
      expect(error.position).toMatchObject(placeOf(config, 'n => 1'));
    });

    // The marks name keys every value the condition may give holds.
    const both = `(${later} ? { a = sensitive("1"), b = sensitive("2") } : { a = sensitive("3"), b = sensitive("4") })`;

    it.each([
      ['an object', `(${later} ? { a = "1", b = "2" } : { a = "3", b = "4" })`],
      ['an object with one attribute sensitive', `(${later} ? { a = sensitive("1"), b = "2" } : { a = sensitive("3"), b = "4" })`],
      ['an object marked at both attributes', both],
      ['a tuple', `(${later} ? ["1", "2"] : ["3", "4"])`],
    ])('refuses at plan a key two items give, over %s not known yet that holds both whatever the apply finds', async (_, collection) => {
      const config = `${random}\noutput "o" {\n  value = { for k, v in ${collection} : "k" => v }\n  sensitive = true\n}`;

      const error = await planError(config);

      expect(error.message).toBe('Two items give the key "k"; write "..." after the value to group them');
      expect(error.position).toMatchObject(placeOf(config, '"k" =>'));
    });

    it('refuses at plan a mistake in an item a collection not known yet holds for certain, read with its type', async () => {
      const config = `${random}\noutput "o" {\n  value = { for k, v in (${later} ? { a = "1" } : { a = "2" }) : k => v.name }\n}`;

      const error = await planError(config);

      expect(error.message).toBe('v is a string and cannot be read into');
      expect(error.position).toMatchObject(placeOf(config, 'v.name'));
    });

    it.each([
      ['grouped', `{ for k, v in ${both} : "k" => v... }`, { k: ['1', '2'] }],
      ['where the if may leave one out', `{ for k, v in ${both} : "k" => v if k == "a" || !(${later}) }`, { k: '1' }],
    ])('waits for the apply with a key two items give over a collection not known yet, %s', async (_, value, expected) => {
      await apply(`${random}\noutput "o" {\n  value = ${value}\n  sensitive = true\n}`);

      const held = await outputs();
      expect(held?.o.value).toEqual(expected);
    });

    it('runs a saved plan whose instances it gives', async () => {
      const config = `${names}
        resource "local_file" "f" {
          for_each = {for i, n in var.names : n => "\${i}"}
          path = "${path.join(dir, '${each.key}.txt')}"
          content = each.value
        }
      `;
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

      for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

      expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('1');
    });
  });
});

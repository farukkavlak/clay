import { types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const REFUSED = 'output "o" holds a sensitive value; write sensitive = true to export it';

const RANDOM = 'resource "random_string" "r" { length = 8 }\n';

/** Never true, since the result has 8 characters, and not known until apply. */
const LATER = 'random_string.r.result == "q"';

describe('an if in a for', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-for-if-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes an instance for each item it keeps', async () => {
    await apply(`variable "servers" {
  default = { a = { on = true }, b = { on = false }, c = { on = true } }
}
resource "local_file" "f" {
  for_each = { for k, v in var.servers : k => v if v.on }
  path = "${path.join(dir, '${each.key}.txt')}"
  content = each.key
}
`);

    const found = await fs.readdir(dir);
    expect(found.filter((name) => name.endsWith('.txt')).sort()).toEqual(['a.txt', 'c.txt']);
  });

  it.each([
    ['a list', '[for x in var.l : x.name if x != null]', ['a', 'c']],
    ['an object', '{ for x in var.l : x.name => x.name if x != null }', { a: 'a', c: 'c' }],
    ['an object that groups', '{ for x in var.l : "all" => x.name... if x != null }', { all: ['a', 'c'] }],
  ])('reads the body of an item it leaves out only by type, in %s', async (_, value, result) => {
    await apply(`variable "l" { default = [{ name = "a" }, null, { name = "c" }] }\noutput "o" { value = ${value} }\n`);

    expect(await outputs()).toMatchObject({ o: { value: result } });
  });

  it.each([
    ['in the body', '[for x in ["a"] : x.nope if false]', 'x.nope', 'x is a string and cannot be read into'],
    ['in the key', '{ for x in ["a"] : x.nope => 1 if false }', 'x.nope', 'x is a string and cannot be read into'],
    ['in the type of a key', '{ for x in [["a"]] : x => 1 if false }', 'x =>', 'A key in a for is a string, a number or a boolean, not a tuple'],
    ['in the type of a key, while the if is not known', `{ for x in [["a"]] : x => 1 if ${LATER} }`, 'x =>', 'A key in a for is a string, a number or a boolean, not a tuple'],
    ['an if that is not a boolean', '[for x in ["a"] : x if x]', 'x]', 'The if of a for takes a boolean, not a string'],
    ['an if that is null', '[for x in ["a"] : x if null]', 'null', 'The if of a for takes a boolean, not null'],
    [
      'an if that is not a boolean, while the collection is not known',
      `[for x in tolist(toset([random_string.r.result])) : x if "s"]`,
      '"s"',
      'The if of a for takes a boolean, not a string',
    ],
  ])('refuses a mistake %s', async (_, value, needle, message) => {
    const config = `${RANDOM}output "o" { value = ${value} }\n`;

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({ message, position: placeOf(config, needle) });
  });

  it('leaves what it gives to the apply while an if is not known', async () => {
    const config = `${RANDOM}output "o" { value = [for x in ["a", "b"] : x if ${LATER}] }\n`;

    const plan = await newOrchestrator().plan(config);
    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.dynamic });

    await apply(config);
    expect(await outputs()).toMatchObject({ o: { value: [] } });
  });

  it('waits for the apply before it refuses two items that give one key, since the if may leave one out', async () => {
    await apply(`${RANDOM}output "o" { value = { for x in ["a", "a"] : x => x if ${LATER} } }\n`);

    expect(await outputs()).toMatchObject({ o: { value: {} } });
  });

  it('reads every item while an if is not known, so a mistake in any is found', async () => {
    const config = `${RANDOM}output "o" { value = [for x in [{ a = 1 }, "b"] : x.a if ${LATER}] }\n`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message: 'x is a string and cannot be read into', position: placeOf(config, 'x.a') });
  });

  describe('sensitive values', () => {
    const secret = 'variable "secret" {\n  default = "a"\n  sensitive = true\n}\n';

    it.each([
      ['an if that reads it', '[for x in ["a", "b"] : x if x == var.secret]'],
      ['an if that reads it, not known yet', `[for x in ["a"] : x if ${LATER} && var.secret == "a"]`],
      ['an if that reads it over a collection not known yet', '[for x in tolist(toset([random_string.r.result])) : x if var.secret == "a"]'],
    ])('makes what it gives sensitive as a whole with %s', async (_, value) => {
      await expect(newOrchestrator().plan(`${secret}${RANDOM}output "o" { value = length(${value}) }\n`)).rejects.toThrow(REFUSED);
    });

    it('makes each item sensitive, and keeps how many it gives plain, where only a body is sensitive under an if not known yet', async () => {
      const value = `[for x in ["a"] : var.secret if ${LATER}]`;

      await expect(newOrchestrator().plan(`${secret}${RANDOM}output "o" { value = ${value} }\n`)).rejects.toThrow(REFUSED);
      const plan = await newOrchestrator().plan(`${secret}${RANDOM}output "o" { value = length(${value}) }\n`);
      expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.number });
    });

    it('makes what it gives sensitive as a whole with a sensitive key under an if not known yet', async () => {
      await expect(newOrchestrator().plan(`${secret}${RANDOM}output "o" { value = length({ for x in ["a"] : var.secret => 1 if ${LATER} }) }\n`)).rejects.toThrow(REFUSED);
    });

    it.each([
      ['the body of an item it kept', '[for x in var.l : x.name if var.secret == "a"]', 'x.name', 'x is null and cannot be read into'],
      [
        'the body of an item it kept while the if of another is not known',
        `[for x in var.l : x.name if (x == null ? var.secret == "a" : ${LATER})]`,
        'x.name',
        'x is null and cannot be read into',
      ],
      [
        'two items it kept that give one key',
        '{ for x in ["k", "k"] : x => 1 if var.secret == "a" }',
        'x =>',
        'Two items give the key "k"; write "..." after the value to group them',
      ],
    ])('tells why %s failed, like any other read', async (_, value, needle, message) => {
      // A list of no type is read as unknown by validate, so only the plan reads the items.
      const config = `${secret}${RANDOM}variable "l" { default = [null, { name = "b" }] }\noutput "o" {\n  value = ${value}\n  sensitive = true\n}\n`;

      await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message, position: placeOf(config, needle) });
    });
  });
});

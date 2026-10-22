import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
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

const variable = (name: string, type: string, value: string) => `variable "${name}" {\n  type = ${type}\n  default = ${value}\n}\n`;

describe('operators and the conditional', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const file = (content: string, count = '') => `resource "local_file" "f" {${count}\n  path = "${path.join(dir, 'f')}\${count.index}.txt"\n  content = ${content}\n}\n`;

  const single = (content: string) => `resource "local_file" "f" {\n  path = "${path.join(dir, 'f.txt')}"\n  content = ${content}\n}\n`;

  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-operators-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes as many instances as a conditional gives', async () => {
    await apply(`${variable('env', 'string', '"prod"')}${file('"x"', '\n  count = var.env == "prod" ? 2 : 1')}`);

    const found = await fs.readdir(dir);
    expect(found.filter((name) => name.endsWith('.txt')).sort()).toEqual(['f0.txt', 'f1.txt']);
  });

  it.each([
    ['null', 'none'],
    ['{ name = "web" }', 'web'],
  ])('reads only the result a condition picks, with x %s', async (x, content) => {
    await apply(`${variable('x', 'object({ name = string })', x)}${single('var.x == null ? "none" : var.x.name')}`);

    expect(await read('f.txt')).toBe(content);
  });

  it.each([
    ['&&', 'var.x != null && var.x.on ? "on" : "off"', 'off'],
    ['||', 'var.x == null || var.x.on ? "on" : "off"', 'on'],
  ])('reads the right side of %s only when the left does not decide', async (_, content, written) => {
    await apply(`${variable('x', 'object({ on = bool })', 'null')}${single(content)}`);

    expect(await read('f.txt')).toBe(written);
  });

  it.each([
    ['a conditional', 'local.x == null ? "none" : local.x.name', 'none'],
    ['&&', 'local.x != null && local.x.on', false],
  ])('reads a local by its type in the side %s does not pick', async (_, value, result) => {
    await apply(`locals { x = null }\noutput "o" { value = ${value} }\n`);

    expect(await outputs()).toMatchObject({ o: { value: result } });
  });

  it('reads a local made from a variable by its type in the result not picked', async () => {
    await apply(`${variable('items', 'list(string)', '[]')}locals { l = [for i in var.items : i] }\noutput "o" { value = local.l == [] ? "none" : local.l[0] }\n`);

    expect(await outputs()).toMatchObject({ o: { value: 'none' } });
  });

  it("reads a call's result by its type in the result not picked", async () => {
    await apply('output "o" { value = true ? "none" : tolist(["a"])[1] }\n');

    expect(await outputs()).toMatchObject({ o: { value: 'none' } });
  });

  it('checks no instance key in the body of a for over nothing, since it is never read', async () => {
    await apply(`${file('"x"', '\n  count = 1')}output "o" { value = [for x in [] : local_file.f[9].path] }\n`);

    expect(await outputs()).toMatchObject({ o: { value: [] } });
  });

  it('takes a variable of no type as a boolean', async () => {
    await apply('variable "on" { default = true }\noutput "o" { value = !var.on }\n');

    expect(await outputs()).toMatchObject({ o: { value: false } });
  });

  it('reads an item of a for only in the result a condition picks', async () => {
    await apply('output "o" { value = [for x in [null, { a = "b" }] : x == null ? "none" : x.a] }\n');

    expect(await outputs()).toMatchObject({ o: { value: ['none', 'b'] } });
  });

  it('reads an instance a count of 0 does not make only on the side not taken', async () => {
    await apply(`${variable('on', 'bool', 'false')}${file('"x"', '\n  count = var.on ? 1 : 0')}output "o" { value = var.on ? local_file.f[0].path : "off" }\n`);

    expect(await outputs()).toEqual({ o: { value: 'off', type: types.string } });
  });

  it.each([
    ['the result a condition picks', 'var.on'],
    ['either result while the condition is not known', 'random_string.r.result == "x"'],
  ])('refuses an instance a count of 0 does not make in %s', async (_, condition) => {
    const config = `${variable('on', 'bool', 'true')}resource "random_string" "r" { length = 8 }\n${file('"x"', '\n  count = 0')}output "o" { value = ${condition} ? local_file.f[0].path : "off" }\n`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message: 'local_file.f has no instances: its count is 0', position: placeOf(config, 'local_file.f[0]') });
  });

  // Its type is known only once it is read, and the result not picked is read by type.
  it('joins a variable of no type with the other result only where the condition picks it', async () => {
    const untyped = 'variable "v" { default = 1 }\n';
    const picked = `${untyped}output "o" { value = true ? var.v : [1] }\n`;

    await expect(newOrchestrator().plan(picked)).rejects.toMatchObject({
      message: 'The result a condition picks cannot join a tuple and a number into one type',
      position: placeOf(picked, 'var.v :'),
    });

    await apply(`${untyped}output "o" { value = false ? var.v : [1] }\n`);
    expect(await outputs()).toEqual({ o: { value: [ExactNumber.parse('1')], type: types.tuple([types.number]) } });
  });

  it('gives a result its two sides join into, whichever the condition picks', async () => {
    await apply(`${variable('on', 'bool', 'true')}output "o" { value = var.on ? ["a"] : tolist([]) }\n`);

    expect(await outputs()).toEqual({ o: { value: ['a'], type: types.list(types.string) } });
  });

  it('leaves a result to the apply while what decides it is not known', async () => {
    const config = `resource "random_string" "r" { length = 8 }
output "o" { value = random_string.r.result == "x" ? "same" : "other" }
output "and" { value = false && random_string.r.result == "x" }
output "or" { value = true || random_string.r.result == "x" }
output "unsure" { value = true && random_string.r.result == "x" }
output "right" { value = random_string.r.result == "x" && false }
`;

    const plan = await newOrchestrator().plan(config);
    expect([plan.outputs.o.new, plan.outputs.and.new, plan.outputs.or.new, plan.outputs.unsure.new, plan.outputs.right.new]).toEqual([
      { value: UNKNOWN, type: types.string },
      { value: false, type: types.bool },
      { value: true, type: types.bool },
      { value: UNKNOWN, type: types.bool },
      { value: false, type: types.bool },
    ]);

    await apply(config);
    expect(await outputs()).toMatchObject({ o: { value: 'other' }, unsure: { value: false } });
  });

  describe('refused by validate', () => {
    it.each([
      [
        'a number compared with a string',
        `${variable('port', 'number', '80')}output "o" { value = var.port == "80" }`,
        '==',
        '== compares a number with a string, which are never equal',
      ],
      ['a condition that is not a boolean', `${variable('name', 'string', '"a"')}output "o" { value = var.name ? 1 : 2 }`, 'var.name', 'A condition takes a boolean, not a string'],
      ['a negated string', `${variable('name', 'string', '"a"')}output "o" { value = !var.name }`, 'var.name', '! takes a boolean, not a string'],
      [
        'results that join into no type, though one is never picked',
        'output "o" { value = true ? 1 : [1] }',
        '1 :',
        'The two results of a conditional cannot join a number and a tuple into one type',
      ],
      [
        'results that join into no type, named in the order written when false is picked',
        'output "o" { value = false ? [1] : 1 }',
        '[1]',
        'The two results of a conditional cannot join a tuple and a number into one type',
      ],
      ['a right side of && that is not a boolean, though it is never read', 'output "o" { value = false && "yes" }', '"yes"', '&& takes a boolean, not a string'],
    ])('%s', async (_, config, needle, message) => {
      await expect(newOrchestrator().validate(config)).rejects.toMatchObject({ message, position: placeOf(config, needle) });
    });

    it('refuses a mistake in the result a condition never picks', async () => {
      const config = `${variable('x', 'object({ name = string })', '{ name = "a" }')}output "o" { value = true ? "a" : var.x.nmae }`;

      await expect(newOrchestrator().validate(config)).rejects.toMatchObject({ message: 'var.x has no key "nmae"', position: placeOf(config, 'var.x.nmae') });
    });
  });

  describe('sensitive values', () => {
    const secret = 'variable "secret" {\n  default = "s"\n  sensitive = true\n}\n';

    it.each([
      [
        'the result a sensitive condition picks',
        'var.secret == "s" ? local_file.f[0].path : "n"',
        'local_file.f[0]',
        'A sensitive condition picked this result, so why it failed is not shown',
      ],
      [
        'the right side of && read for a sensitive left side',
        'var.secret == "s" && local_file.f[0].path == "x"',
        'local_file.f[0]',
        'The right side of && was read for a sensitive left side, so why it failed is not shown',
      ],
    ])('hides why %s failed, since it would tell the secret', async (_, value, needle, message) => {
      const config = `${secret}${file('"x"', '\n  count = 0')}output "o" {\n  value = ${value}\n  sensitive = true\n}\n`;

      await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message, position: placeOf(config, needle) });
    });

    it('tells why the right side of && failed when the sensitive left side is not known yet', async () => {
      const config = 'resource "random_string" "r" { length = 8 }\noutput "o" { value = sensitive(random_string.r.result == "x") && "yes" }';

      await expect(newOrchestrator().validate(config)).rejects.toMatchObject({ message: '&& takes a boolean, not a string', position: placeOf(config, '"yes"') });
    });

    it.each([
      ['a sensitive condition', 'var.secret == "s" ? "a" : "b"'],
      ['a sensitive result the condition picks', 'true ? var.secret : "b"'],
      ['a sensitive result while the condition is not known', 'random_string.r.result == "x" ? var.secret : "b"'],
      ['a comparison with a sensitive part', '{ a = sensitive("x") } == { a = "x" }'],
      ['&& with a sensitive side', 'true && var.secret == "s"'],
      ['a sensitive side that decides &&', 'var.secret == "x" && true'],
    ])('makes the result sensitive with %s', async (_, value) => {
      const config = `${secret}resource "random_string" "r" { length = 8 }\noutput "o" { value = ${value} }`;

      await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED);
    });

    it.each([
      ['a sensitive result the condition does not pick', 'false ? var.secret : "b"', 'b'],
      ['a sensitive side && does not read', 'false && var.secret == "s"', false],
      ['a sensitive part compared with null', '{ a = sensitive("x") } == null', false],
    ])('keeps the result plain with %s', async (_, value, result) => {
      await apply(`${secret}output "o" { value = ${value} }`);

      expect(await outputs()).toMatchObject({ o: { value: result } });
    });
  });
});

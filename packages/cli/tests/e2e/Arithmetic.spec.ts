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

const RANDOM = 'resource "random_string" "r" { length = 8 }\n';

describe('arithmetic and ordering', () => {
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-arithmetic-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes as many instances as a sum gives, and writes a number worked out from the index', async () => {
    await apply(`variable "n" { default = 1 }
resource "local_file" "f" {
  count = var.n * 2 + 1
  path = "${path.join(dir, 'f')}\${count.index}.txt"
  content = count.index * 10 - 1
}
`);

    const found = await fs.readdir(dir);
    expect(found.filter((name) => name.endsWith('.txt')).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
    expect(await fs.readFile(path.join(dir, 'f2.txt'), 'utf8')).toBe('19');
  });

  it.each([
    ['decimals', '0.1 + 0.2', '0.3'],
    ['a number past 2^53', '9007199254740993 * 10 - 1', '90071992547409929'],
    ['* before + and -', '1 + 2 * 3 - 4', '3'],
    ['parentheses first', '(1 + 2) * 3', '9'],
    ['a minus before a reference', '-var.n * 2', '-6'],
    ['a string that spells a number', 'var.s + 1', '9'],
  ])('works out %s exactly into the state', async (_, value, result) => {
    await apply(`variable "n" { default = 3 }\nvariable "s" { default = "8" }\noutput "o" { value = ${value} }\n`);

    expect(await outputs()).toMatchObject({ o: { value: ExactNumber.parse(result), type: types.number } });
  });

  it.each([
    ['var.n < 4', true],
    ['var.n <= 2', false],
    ['var.n > 2 && var.n >= 3', true],
    ['var.n + 1 > 4 == false', true],
  ])('answers %s', async (value, answer) => {
    await apply(`variable "n" { default = 3 }\noutput "o" { value = ${value} }\n`);

    expect(await outputs()).toMatchObject({ o: { value: answer } });
  });

  it.each([
    ['a string that spells no number', 'output "o" { value = "8 MB" + 1 }', '"8 MB"', '+ takes a number, and "8 MB" is not a number'],
    ['two strings to order', 'output "o" { value = "a" < "b" }', '"a"', '< takes a number, and "a" is not a number'],
    ['a boolean, by its type', 'variable "b" {\n  type = bool\n  default = true\n}\noutput "o" { value = var.b * 2 }', 'var.b', '* takes a number, not a boolean'],
    ['null', 'output "o" { value = 1 - null }', 'null', '- takes a number, not null'],
    ['a minus before a list', 'output "o" { value = -[1] }', '[1]', '- takes a number, not a tuple'],
    [
      'a result out of range, at its operator',
      'output "o" { value = 1e999 * 10 }',
      '*',
      'What * gives is out of range: a number reaches at most 1000 places either side of the point',
    ],
  ])('refuses %s', async (_, config, needle, message) => {
    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({ message, position: placeOf(config, needle) });
  });

  it('leaves a result to the apply while a side is not known', async () => {
    const config = `${RANDOM}output "o" { value = length(random_string.r.result) * 2 }\n`;

    const plan = await newOrchestrator().plan(config);
    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.number });

    await apply(config);
    expect(await outputs()).toMatchObject({ o: { value: ExactNumber.parse('16') } });
  });

  describe('sensitive values', () => {
    const secret = 'variable "secret" {\n  default = 2\n  sensitive = true\n}\n';

    it.each([
      ['a sum', 'var.secret + 1'],
      ['a negation', '-var.secret'],
      ['an ordering', 'var.secret < 3'],
    ])('makes %s sensitive where a side is', async (_, value) => {
      await expect(newOrchestrator().plan(`${secret}output "o" { value = ${value} }\n`)).rejects.toThrow(REFUSED);
    });

    it('does not show a sensitive string that spells no number', async () => {
      const config = 'variable "secret" {\n  default = "8 MB"\n  sensitive = true\n}\noutput "o" {\n  value = var.secret + 1\n  sensitive = true\n}\n';

      await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
        message: '+ takes a number, and (sensitive value) is not a number',
        position: placeOf(config, 'var.secret +'),
      });
    });
  });
});

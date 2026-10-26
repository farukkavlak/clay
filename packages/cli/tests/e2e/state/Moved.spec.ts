import { Address } from '@clay/contracts';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorOf, orchestratorIn, placeOf } from '../helpers';
import { start } from '../start';

const moved = (from: string, to: string) => `moved {\n from = ${from}\n to = ${to}\n}\n`;

describe('a moved block', () => {
  let dir: string;

  const file = (name: string, head = '') => `resource "local_file" "${name}" {\n ${head}\n path = "${path.join(dir, 'f.txt')}"\n content = "x"\n}\n`;

  const apply = async (config: string) => {
    for await (const event of start(orchestratorIn(dir), config)) if (event.type === 'failed') throw event.error;
  };

  const planned = async (config: string) => {
    const { actions } = await orchestratorIn(dir).plan(config);
    return actions.map(({ type, name, key, movedFrom }) => [type, name, key, movedFrom]);
  };

  const counted = (name: string, count: number) =>
    `resource "local_file" "${name}" {\n count = ${count}\n path = "${path.join(dir, `${name}-\${count.index}.txt`)}"\n content = "x"\n}\n`;

  const inModule = (name: string) => file(name).replace('f.txt', '${var.n}.txt');

  const writeModule = async (body: string, name = 'm') => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), body, 'utf8');
  };

  const stateKeys = async () => {
    const { resources } = await new LocalBackend(dir).read();
    return Object.keys(resources).sort();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-moved-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('moves a renamed resource in the state, and the file stays', async () => {
    await apply(file('a'));
    const config = file('b') + moved('local_file.a', 'local_file.b');

    expect(await planned(config)).toEqual([['NO_OP', 'b', undefined, 'local_file.a']]);
    await apply(config);
    expect(await stateKeys()).toEqual(['local_file.b']);
    expect(await fs.readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('x');
  });

  it('moves nothing once the state holds no from, so the block can stay', async () => {
    await apply(file('b'));

    expect(await planned(file('b') + moved('local_file.a', 'local_file.b'))).toEqual([['NO_OP', 'b', undefined, undefined]]);
  });

  it('follows a chain in one step, and a count after it', async () => {
    await apply(file('a'));
    const config = file('c', 'count = 1') + moved('local_file.b', 'local_file.c') + moved('local_file.a', 'local_file.b');

    expect(await planned(config)).toEqual([['NO_OP', 'c', 0, 'local_file.a']]);
  });

  it('moves one instance to a for_each key', async () => {
    await apply(file('a'));

    expect(await planned(file('a', 'for_each = ["web"]') + moved('local_file.a', 'local_file.a["web"]'))).toEqual([['NO_OP', 'a', 'web', 'local_file.a']]);
  });

  it('moves an instance before the rest of its resource', async () => {
    await apply(counted('a', 2));
    const config = file('c') + counted('b', 2) + moved('local_file.a', 'local_file.b') + moved('local_file.a[0]', 'local_file.c');

    const actions = await planned(config);
    expect(actions.map(([, name, key, from]) => [name, key, from])).toEqual([
      ['c', undefined, 'local_file.a[0]'],
      ['b', 0, undefined],
      ['b', 1, 'local_file.a[1]'],
    ]);
  });

  it('moves in each instance of the module that declares it', async () => {
    await writeModule(file('a').replace('f.txt', '${var.n}.txt') + 'variable "n" {}\n');
    const call = 'module "m" {\n source = "./m"\n count = 2\n n = "m${count.index}"\n}\n';
    await apply(call);
    await writeModule(file('b').replace('f.txt', '${var.n}.txt') + 'variable "n" {}\n' + moved('local_file.a', 'local_file.b'));

    await apply(call);
    expect(await stateKeys()).toEqual(['module.m[0].local_file.b', 'module.m[1].local_file.b']);
  });

  it('leaves alone a resource of the same name outside the module that declares it', async () => {
    await writeModule(file('b').replace('f.txt', 'm.txt'));
    await writeModule(file('a').replace('f.txt', 'n.txt'), 'n');
    const calls = 'module "m" {\n source = "./m"\n}\nmodule "n" {\n source = "./n"\n}\n';
    await apply(file('a') + calls);
    await writeModule(file('b').replace('f.txt', 'm.txt') + moved('local_file.a', 'local_file.b'));

    await apply(file('a') + calls);
    expect(await stateKeys()).toEqual(['local_file.a', 'module.m.local_file.b', 'module.n.local_file.a']);
  });

  it('moves a resource from the root into a module', async () => {
    await apply(file('a'));
    await writeModule(file('a'));
    const config = 'module "m" {\n source = "./m"\n}\n' + moved('local_file.a', 'module.m.local_file.a');

    await apply(config);
    expect(await stateKeys()).toEqual(['module.m.local_file.a']);
  });

  it('refuses a whole resource where any instance of its new one is held', async () => {
    await apply(file('a') + counted('b', 1));

    const error = await errorOf(() => orchestratorIn(dir).plan(counted('b', 1) + moved('local_file.a', 'local_file.b')));
    expect(error.message).toContain('local_file.a cannot move to local_file.b: the state already holds local_file.b[0]');
  });

  it('destroys at the new address a to the configuration does not declare', async () => {
    await apply(file('a'));

    const config = moved('local_file.a', 'local_file.b');

    expect(await planned(config)).toEqual([['DELETE', 'b', undefined, 'local_file.a']]);
    await apply(config);
    expect(await stateKeys()).toEqual([]);
    await expect(fs.access(path.join(dir, 'f.txt'))).rejects.toThrow('ENOENT');
  });

  describe('written in a module and in its caller', () => {
    const call = 'module "m" {\n source = "./m"\n count = 2\n n = "m${count.index}"\n}\n';

    it('refuses an instance of the module moved to two places, at the later block', async () => {
      const module = inModule('b') + 'variable "n" {}\n' + moved('local_file.a', 'local_file.b');
      await writeModule(module);

      const error = await errorOf(() => orchestratorIn(dir).plan(call + moved('module.m[0].local_file.a', 'module.m[0].local_file.c')));
      expect(error.message).toContain('module.m[0].local_file.a is moved to both module.m[0].local_file.c and module.m[0].local_file.b');
      expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, 'moved {') });
    });

    it('takes moves of the same name in other instances, modules or depths as apart', async () => {
      await writeModule('variable "n" {}\n');
      await writeModule('', 'n');
      const config =
        call +
        'module "n" {\n source = "./n"\n}\nmodule "o" {\n source = "./n"\n}\n' +
        moved('module.m[0].local_file.a', 'module.m[0].local_file.b') +
        moved('module.m[1].local_file.a', 'module.m[1].local_file.c') +
        moved('module.n.local_file.a', 'module.n.local_file.b') +
        moved('module.o.local_file.a', 'module.o.local_file.c') +
        moved('local_file.a', 'local_file.b');

      expect(await planned(config)).toEqual([]);
    });

    it('follows a chain from the module into its caller', async () => {
      await writeModule(inModule('a') + 'variable "n" {}\n');
      const single = call.replace('count = 2', 'count = 1');
      await apply(single);
      await writeModule(inModule('c') + 'variable "n" {}\n' + moved('local_file.a', 'local_file.b'));

      const { actions } = await orchestratorIn(dir).plan(single + moved('module.m[0].local_file.b', 'module.m[0].local_file.c'));
      expect(actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom])).toEqual([['NO_OP', 'module.m[0].local_file.c', 'module.m[0].local_file.a']]);
    });
  });

  it('runs a saved plan read back from its file', async () => {
    await apply(file('a'));
    const config = file('b') + moved('local_file.a', 'local_file.b');
    const saved = parsePlanFile(serializePlan(await orchestratorIn(dir).plan(config), config, {}), 'plan.json');

    for await (const event of orchestratorIn(dir).runPlan(saved, config)) if (event.type === 'failed') throw event.error;
    expect(await stateKeys()).toEqual(['local_file.b']);
  });

  it('refuses a saved plan with a move the configuration does not make', async () => {
    await apply(file('a'));
    const config = file('b') + moved('local_file.a', 'local_file.b');
    const saved = await orchestratorIn(dir).plan(config);

    await expect(async () => {
      for await (const event of orchestratorIn(dir).runPlan(saved, file('b'))) if (event.type === 'failed') throw event.error;
    }).rejects.toThrow('The saved plan moves local_file.b from local_file.a, which the configuration does not. Plan again.');
  });

  it.each([
    [
      'from still declared',
      () => file('a') + file('c').replace('f.txt', 'h.txt') + moved('local_file.a', 'local_file.c'),
      'local_file.a is moved to local_file.c, but it is still declared',
      moved('local_file.a', 'local_file.c'),
    ],
    [
      'the state already holding to',
      () => file('b') + moved('local_file.a', 'local_file.b'),
      'local_file.a cannot move to local_file.b: the state already holds local_file.b',
      moved('local_file.a', 'local_file.b'),
    ],
    [
      'one address moved to two places',
      () => file('b') + moved('local_file.a', 'local_file.b') + moved('local_file.a', 'local_file.c'),
      'local_file.a is moved to both local_file.b and local_file.c',
      moved('local_file.a', 'local_file.c'),
    ],
    [
      'two addresses moved to one place',
      () => file('c') + moved('local_file.a', 'local_file.c') + moved('local_file.b', 'local_file.c'),
      'local_file.c is moved to from both local_file.a and local_file.b',
      moved('local_file.b', 'local_file.c'),
    ],
    [
      'blocks in a circle',
      () => file('c') + moved('local_file.a', 'local_file.b') + moved('local_file.b', 'local_file.a'),
      'moved blocks move in a circle',
      moved('local_file.a', 'local_file.b'),
    ],
  ])('refuses %s, at the block', async (_, config, message, block) => {
    await apply(file('a') + file('b').replace('f.txt', 'g.txt'));

    const error = await errorOf(() => orchestratorIn(dir).plan(config()));
    expect(error.message).toContain(message);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config(), block) });
  });
});

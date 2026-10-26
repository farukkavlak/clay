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

/** A call of `./m`, whose files are named by `n`. */
const call = (name: string, n = name, head = '') => `module "${name}" {\n source = "./m"\n n = "${n}"\n ${head}\n}\n`;
const countedCall = (name: string, count: number) => call(name, `${name}\${count.index}`, `count = ${count}`);

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

  const keysAfter = async (config: string) => {
    await apply(config);
    return stateKeys();
  };

  const moves = async (config: string) => {
    const { actions } = await orchestratorIn(dir).plan(config);
    return actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom]);
  };

  /** `./m`: a resource and a call of `./m/c`, which `each` repeats. */
  const moduleBody = (name = 'a', extra = '', each = '') => inModule(name) + `variable "n" {}\nmodule "c" {\n source = "./c"\n n = "\${var.n}-c"\n ${each}\n}\n` + extra;

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

  describe('of a module', () => {
    beforeEach(async () => {
      await writeModule(moduleBody());
      await writeModule(inModule('a') + 'variable "n" {}\n', path.join('m', 'c'));
    });

    it('moves a renamed call with every resource in it and in the modules under it, and the files stay', async () => {
      await apply(call('a'));
      const config = call('b', 'a') + moved('module.a', 'module.b');

      expect(await moves(config)).toEqual([
        ['NO_OP', 'module.b.local_file.a', 'module.a.local_file.a'],
        ['NO_OP', 'module.b.module.c.local_file.a', 'module.a.module.c.local_file.a'],
      ]);
      expect(await keysAfter(config)).toEqual(['module.b.local_file.a', 'module.b.module.c.local_file.a']);
      expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('x');
    });

    it('moves each instance of a whole call to the same key', async () => {
      await apply(countedCall('a', 2));

      expect(await keysAfter(countedCall('b', 2).replaceAll('n = "b', 'n = "a') + moved('module.a', 'module.b'))).toEqual([
        'module.b[0].local_file.a',
        'module.b[0].module.c.local_file.a',
        'module.b[1].local_file.a',
        'module.b[1].module.c.local_file.a',
      ]);
    });

    it('moves one instance, and leaves the others where they are', async () => {
      await apply(call('a', 'a${each.key}', 'for_each = ["x", "y"]'));
      const config = call('a', 'a${each.key}', 'for_each = ["y"]') + call('b', 'ax', 'for_each = ["z"]') + moved('module.a["x"]', 'module.b["z"]');

      expect(await moves(config)).toEqual([
        ['NO_OP', 'module.a["y"].local_file.a', undefined],
        ['NO_OP', 'module.b["z"].local_file.a', 'module.a["x"].local_file.a'],
        ['NO_OP', 'module.a["y"].module.c.local_file.a', undefined],
        ['NO_OP', 'module.b["z"].module.c.local_file.a', 'module.a["x"].module.c.local_file.a'],
      ]);
    });

    it('moves a module under a call', async () => {
      await apply(call('a'));
      await writeModule(moduleBody().replace('module "c"', 'module "d"'));

      expect(await moves(call('a') + moved('module.a.module.c', 'module.a.module.d'))).toEqual([
        ['NO_OP', 'module.a.local_file.a', undefined],
        ['NO_OP', 'module.a.module.d.local_file.a', 'module.a.module.c.local_file.a'],
      ]);
    });

    it('moves a module up into the call above it', async () => {
      await writeModule('module "c" {\n source = "../m/c"\n n = "x"\n}\n', 'n');
      await apply('module "x" {\n source = "./n"\n}\n');

      expect(await moves(call('x', 'x').replace('./m', './m/c') + moved('module.x.module.c', 'module.x'))).toEqual([
        ['NO_OP', 'module.x.local_file.a', 'module.x.module.c.local_file.a'],
      ]);
    });

    it('follows a chain of calls in one step', async () => {
      await apply(call('a'));

      expect(await keysAfter(call('c', 'a') + moved('module.b', 'module.c') + moved('module.a', 'module.b'))).toEqual(['module.c.local_file.a', 'module.c.module.c.local_file.a']);
    });

    it('moves a call before a resource in the call it moves to', async () => {
      await apply(call('a'));
      await writeModule(inModule('z') + 'variable "n" {}\n', path.join('m', 'c'));

      expect(await moves(call('b', 'a') + moved('module.b.module.c.local_file.a', 'module.b.module.c.local_file.z') + moved('module.a', 'module.b'))).toEqual([
        ['NO_OP', 'module.b.local_file.a', 'module.a.local_file.a'],
        ['NO_OP', 'module.b.module.c.local_file.z', 'module.a.module.c.local_file.a'],
      ]);
    });

    it('moves a module to a key, then the move inside it', async () => {
      await apply(call('m'));
      await writeModule(moduleBody('b', moved('local_file.a', 'local_file.b')));

      expect(await keysAfter(call('m', 'm', 'for_each = ["web"]') + moved('module.m', 'module.m["web"]'))).toEqual([
        'module.m["web"].local_file.b',
        'module.m["web"].module.c.local_file.a',
      ]);
    });

    it('moves inside a module instance before the instance moves out of its call', async () => {
      await writeModule(moduleBody('a', '', 'for_each = ["a"]'));
      await apply(call('m'));
      await writeModule(inModule('b') + 'variable "n" {}\n' + moved('local_file.a', 'local_file.b'), path.join('m', 'c'));
      await writeModule(inModule('b') + 'variable "n" {}\n', path.join('m', 'k'));
      await writeModule(moduleBody('a', 'module "k" {\n source = "./k"\n n = "${var.n}-c"\n}\n' + moved('module.c["a"]', 'module.k'), 'for_each = []'));

      expect(await moves(call('m'))).toEqual([
        ['NO_OP', 'module.m.local_file.a', undefined],
        ['NO_OP', 'module.m.module.k.local_file.b', 'module.m.module.c["a"].local_file.a'],
      ]);
    });

    it('moves inside a module before a move beside it changes only its key', async () => {
      await apply(call('m'));
      await writeModule(inModule('b') + 'variable "n" {}\n', path.join('m', 'c'));
      const reindex = moved('module.c', 'module.c["x"]') + moved('module.c.local_file.a', 'module.c.local_file.b');
      await writeModule(moduleBody('a', reindex, 'for_each = ["x"]'));

      expect(await moves(call('m'))).toEqual([
        ['NO_OP', 'module.m.local_file.a', undefined],
        ['NO_OP', 'module.m.module.c["x"].local_file.b', 'module.m.module.c.local_file.a'],
      ]);
    });

    it('runs a saved plan that moves a call', async () => {
      await apply(call('a'));
      const config = call('b', 'a') + moved('module.a', 'module.b');
      const saved = parsePlanFile(serializePlan(await orchestratorIn(dir).plan(config), { 'main.clay': config }), 'plan.json');

      for await (const event of orchestratorIn(dir).runPlan(saved, config)) if (event.type === 'failed') throw event.error;
      expect(await stateKeys()).toEqual(['module.b.local_file.a', 'module.b.module.c.local_file.a']);
    });

    it.each([
      [
        'a call still declared',
        () => call('a') + call('b') + moved('module.a', 'module.b'),
        'module.a is moved to module.b, but it is still declared',
        moved('module.a', 'module.b'),
      ],
      [
        'an instance still declared',
        () => call('a', 'a', 'for_each = ["x"]') + call('b', 'b', 'for_each = ["x"]') + moved('module.a["x"]', 'module.b["x"]'),
        'module.a["x"] is moved to module.b["x"], but it is still declared',
        moved('module.a["x"]', 'module.b["x"]'),
      ],
      [
        'a call where its new call is held',
        () => call('d') + moved('module.a', 'module.d'),
        'module.a.local_file.a cannot move to module.d.local_file.a: the state already holds module.d.local_file.a',
        moved('module.a', 'module.d'),
      ],
      [
        'a call to two places',
        () => call('b') + moved('module.a', 'module.b') + moved('module.a', 'module.c'),
        'module.a is moved to both module.b and module.c',
        moved('module.a', 'module.c'),
      ],
      ['calls in a circle', () => call('b') + moved('module.a', 'module.b') + moved('module.b', 'module.a'), 'moved blocks move in a circle', moved('module.a', 'module.b')],
    ])('refuses %s, at the block', async (_, config, message, block) => {
      await apply(call('a') + call('d'));

      const error = await errorOf(() => orchestratorIn(dir).plan(config()));
      expect(error.message).toContain(message);
      expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config(), block) });
    });

    it('refuses a call still declared with nothing in it', async () => {
      await writeModule('', 'e');
      await apply(call('a'));

      const error = await errorOf(() => orchestratorIn(dir).plan(call('b', 'a') + 'module "e" {\n source = "./e"\n}\n' + moved('module.e', 'module.b')));
      expect(error.message).toContain('module.e is moved to module.b, but it is still declared');
    });

    it('moves an instance beside one its new call holds', async () => {
      await apply(countedCall('a', 1) + countedCall('b', 1));

      const actions = await moves(countedCall('b', 2) + moved('module.a[0]', 'module.b[1]'));
      expect(actions.filter((action) => action[2] !== undefined)).toEqual([
        ['REPLACE', 'module.b[1].local_file.a', 'module.a[0].local_file.a'],
        ['REPLACE', 'module.b[1].module.c.local_file.a', 'module.a[0].module.c.local_file.a'],
      ]);
    });

    it('refuses an instance where its new instance is held, at the block', async () => {
      await apply(countedCall('a', 1) + countedCall('b', 1));
      const config = countedCall('b', 1) + moved('module.a[0]', 'module.b[0]');

      const error = await errorOf(() => orchestratorIn(dir).plan(config));
      expect(error.message).toContain('module.a[0].local_file.a cannot move to module.b[0].local_file.a: the state already holds module.b[0].');
      expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, moved('module.a[0]', 'module.b[0]')) });
    });

    it('refuses a whole call where an instance of its new call is held', async () => {
      await apply(call('a') + countedCall('b', 1));

      const error = await errorOf(() => orchestratorIn(dir).plan(countedCall('b', 1) + moved('module.a', 'module.b')));
      expect(error.message).toContain('module.a.local_file.a cannot move to module.b.local_file.a: the state already holds module.b[0].');
    });
  });

  it('runs a saved plan read back from its file', async () => {
    await apply(file('a'));
    const config = file('b') + moved('local_file.a', 'local_file.b');
    const saved = parsePlanFile(serializePlan(await orchestratorIn(dir).plan(config), { 'main.clay': config }), 'plan.json');

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

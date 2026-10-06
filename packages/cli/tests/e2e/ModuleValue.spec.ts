import { types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
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

const PAGE = types.object({ path: types.string, content: types.string });

const web = (repetition = '', name = '"one"') => `module "web" {\n  source = "./web"\n  ${repetition}\n  name = ${name}\n}`;

describe('a whole module read as a value', () => {
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
    return state.outputs!;
  };

  const output = async (name: string) => {
    const all = await outputs();
    return all[name];
  };

  const at = (name: string) => path.join(dir, `${name}.txt`);

  const page = (name: string) => ({ path: at(name), content: `page ${name}` });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-value-'));
    await fs.mkdir(path.join(dir, 'web'));
    await fs.writeFile(
      path.join(dir, 'web', 'main.clay'),
      `variable "name" {}\nresource "local_file" "page" {\n  path = "${path.join(dir, '${var.name}.txt')}"\n  content = "page \${var.name}"\n}\noutput "path" { value = local_file.page.path }\noutput "content" { value = local_file.page.content }`
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives a module with no count or for_each as an object of its outputs', async () => {
    await apply(`${web()}\noutput "web" { value = module.web }`);

    expect(await output('web')).toEqual({ value: page('one'), type: PAGE });
  });

  it('gives one instance by its index, and one by its key', async () => {
    await apply(
      `${web('count = 2', '"${count.index}"')}\nmodule "keyed" {\n  source = "./web"\n  for_each = ["a"]\n  name = each.key\n}\noutput "one" { value = module.web[1] }\noutput "a" { value = module.keyed["a"] }`
    );

    const { one, a } = await outputs();
    expect(one).toEqual({ value: page('1'), type: PAGE });
    expect(a).toEqual({ value: page('a'), type: PAGE });
  });

  it('gives a list in index order under count', async () => {
    await apply(`${web('count = 2', '"${count.index}"')}\noutput "web" { value = module.web }`);

    expect(await output('web')).toEqual({ value: [page('0'), page('1')], type: types.list(PAGE) });
  });

  it('gives a map by key under for_each', async () => {
    await apply(`${web('for_each = ["a", "b"]', 'each.key')}\noutput "web" { value = module.web }`);

    expect(await output('web')).toEqual({ value: { a: page('a'), b: page('b') }, type: types.map(PAGE) });
  });

  // No instance gives a value, so the outputs have no type to read.
  it('gives an empty list where count is 0', async () => {
    await apply(`${web('count = 0')}\noutput "web" { value = module.web }`);

    expect(await output('web')).toEqual({ value: [], type: types.list(types.object({ path: types.dynamic, content: types.dynamic })) });
  });

  // Without every output read first, the for_each would find none.
  it('feeds a for_each, read after every output of every instance', async () => {
    await apply(
      `${web('for_each = ["a", "b"]', 'each.key')}\nresource "local_file" "copy" {\n  for_each = module.web\n  path = "${path.join(dir, 'copy-${each.key}.txt')}"\n  content = "copy of \${each.value.content}"\n}`
    );

    expect(await fs.readFile(at('copy-a'), 'utf8')).toBe('copy of page a');
    expect(await fs.readFile(at('copy-b'), 'utf8')).toBe('copy of page b');
  });

  it('refuses instances whose outputs take no one type, where the reference is written', async () => {
    await fs.mkdir(path.join(dir, 'echo'));
    await fs.writeFile(path.join(dir, 'echo', 'main.clay'), 'variable "v" {}\noutput "v" { value = var.v }');
    const config = 'module "echo" {\n  source = "./echo"\n  for_each = { a = "text", b = ["list"] }\n  v = each.value\n}\noutput "o" { value = module.echo }';

    const error = await planError(config);

    expect(error.message).toBe('module.echo cannot join a string and a tuple into one type, at .v in each item');
    expect(error.position).toMatchObject(placeOf(config, 'module.echo }'));
  });

  // No instance is read, so only the type the reference will have can refuse it.
  it('refuses every instance where an attribute takes a string, in a block that makes no instance', async () => {
    const config = `${web('count = 2', '"${count.index}"')}\nresource "local_file" "none" {\n  count = 0\n  path = "${at('none')}"\n  content = module.web\n}`;

    const error = await planError(config);

    expect(error.message).toBe('content is a list, where local_file takes a string');
    expect(error.position).toMatchObject(placeOf(config, 'module.web\n}'));
  });

  it.each([
    ['a module with no count', web(), 'module.web'],
    ['one instance by its index', web('count = 2', '"${count.index}"'), 'module.web[0]'],
  ])('refuses %s where an attribute takes a string, in a block that makes no instance', async (_, call, reference) => {
    const config = `${call}\nresource "local_file" "none" {\n  count = 0\n  path = "${at('none')}"\n  content = ${reference}\n}`;

    const error = await planError(config);

    expect(error.message).toBe('content is an object, where local_file takes a string');
    expect(error.position).toMatchObject(placeOf(config, `${reference}\n}`));
  });

  // Each instance of `site` reads the instances of its own `module.inner`, not those of another.
  it('reads every instance of a module called inside each instance of another', async () => {
    await fs.mkdir(path.join(dir, 'site'));
    await fs.writeFile(
      path.join(dir, 'site', 'main.clay'),
      'variable "i" {}\nmodule "inner" {\n  source = "../web"\n  for_each = ["a", "b"]\n  name = "${var.i}-${each.key}"\n}\noutput "all" { value = module.inner }'
    );

    await apply('module "site" {\n  source = "./site"\n  count = 2\n  i = count.index\n}\noutput "second" { value = module.site[1].all }');

    expect(await output('second')).toEqual({ value: { a: page('1-a'), b: page('1-b') }, type: types.map(PAGE) });
  });

  it('plans every instance with what only the apply makes unknown in each', async () => {
    await fs.mkdir(path.join(dir, 'rand'));
    await fs.writeFile(path.join(dir, 'rand', 'main.clay'), 'resource "random_string" "s" { length = 4 }\noutput "id" { value = random_string.s.id }');

    const { outputs: planned } = await newOrchestrator().plan('module "rand" {\n  source = "./rand"\n  count = 2\n}\noutput "ids" { value = module.rand }');

    expect(planned.ids.new).toEqual({ value: [{ id: UNKNOWN }, { id: UNKNOWN }], type: types.list(types.object({ id: types.string })) });
  });
});

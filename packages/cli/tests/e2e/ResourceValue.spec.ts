import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
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

const FILE = types.object({ id: types.string, path: types.string, content: types.string });

describe('a whole resource instance read as a value', () => {
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

  const at = (name: string) => path.join(dir, `${name}.txt`);

  const single = () => `resource "local_file" "one" {\n  path = "${at('one')}"\n  content = "hi"\n}`;

  const counted = () => `resource "local_file" "logs" {\n  count = 2\n  path = "${path.join(dir, 'log-${count.index}.txt')}"\n  content = "log \${count.index}"\n}`;

  const keyed = () => `resource "local_file" "f" {\n  for_each = ["a", "b"]\n  path = "${path.join(dir, '${each.key}.txt')}"\n  content = "\${each.value}"\n}`;

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-resource-value-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives a resource with no count or for_each as an object of its attributes', async () => {
    await apply(`${single()}\noutput "one" { value = local_file.one }`);

    expect(await outputs()).toEqual({ one: { value: { id: at('one'), path: at('one'), content: 'hi' }, type: FILE } });
  });

  it('gives one instance by its index, and one by its key', async () => {
    await apply(`${counted()}\n${keyed()}\noutput "log" { value = local_file.logs[1] }\noutput "b" { value = local_file.f["b"] }`);

    const log = path.join(dir, 'log-1.txt');
    expect(await outputs()).toEqual({
      log: { value: { id: log, path: log, content: 'log 1' }, type: FILE },
      b: { value: { id: at('b'), path: at('b'), content: 'b' }, type: FILE },
    });
  });

  it('holds every attribute of the schema, with null for one the configuration leaves out', async () => {
    await apply(
      'resource "random_string" "s" { length = 4 }\noutput "names" { value = [for name, value in random_string.s : name] }\noutput "special" { value = random_string.s.special }'
    );

    const { names, special } = (await outputs())!;
    expect(names.value).toEqual(['id', 'length', 'result', 'special']);
    expect(special.value).toBeNull();
  });

  it('is counted by length and read into by a for', async () => {
    await apply(`${counted()}\noutput "n" { value = length(local_file.logs[0]) }\noutput "shout" { value = [for name, value in local_file.logs[0] : "\${name}=\${value}"] }`);

    const log = path.join(dir, 'log-0.txt');
    const { n, shout } = (await outputs())!;
    expect(n.value).toEqual(ExactNumber.parse('3'));
    expect(shout.value).toEqual(['content=log 0', `id=${log}`, `path=${log}`]);
  });

  it('plans what the configuration sets as known and what the apply makes as unknown, each by itself', async () => {
    const { outputs: planned } = await newOrchestrator().plan('resource "random_string" "s" { length = 4 }\noutput "s" { value = random_string.s }');

    expect(planned.s.new?.value).toEqual({ id: UNKNOWN, length: ExactNumber.parse('4'), result: UNKNOWN, special: null });
  });

  it('plans an instance that is already in state as known in full', async () => {
    await apply(single());

    const { outputs: planned } = await newOrchestrator().plan(`${single()}\noutput "one" { value = local_file.one }`);

    expect(planned.one.new?.value).toEqual({ id: at('one'), path: at('one'), content: 'hi' });
  });

  it('reads an instance a module makes, and one a module gives as an output', async () => {
    await fs.mkdir(path.join(dir, 'web'));
    await fs.writeFile(
      path.join(dir, 'web', 'main.clay'),
      `resource "local_file" "page" {\n  path = "${at('page')}"\n  content = "home"\n}\noutput "page" { value = local_file.page }\noutput "size" { value = length(local_file.page) }`
    );

    await apply('module "web" { source = "./web" }\noutput "content" { value = module.web.page.content }\noutput "size" { value = module.web.size }');

    const { content, size } = (await outputs())!;
    expect(content.value).toBe('home');
    expect(size.value).toEqual(ExactNumber.parse('3'));
  });

  it.each([
    ['all of a resource that has count', 'local_file.logs', 'local_file.logs has count, so name one of it by index, as in local_file.logs[0]'],
    ['all of a resource that has for_each', 'local_file.f', 'local_file.f has for_each, so name one of it by key, as in local_file.f["key"]'],
    ['an index of a resource that has no count', 'local_file.one[0]', 'local_file.one has no count, so it takes no index'],
    ['an index past its count', 'local_file.logs[2]', 'local_file.logs has 2 instances, [0] to [1]'],
    ['a resource that is not declared', 'local_file.other', '"local_file.other" is not declared in the configuration'],
  ])('refuses a reference to %s, where it is written', async (_, reference, message) => {
    const config = `${single()}\n${counted()}\n${keyed()}\noutput "o" { value = ${reference} }`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, `${reference} }`));
  });

  it('refuses an instance joined into a string, before anything is made', async () => {
    const config = `${single()}\noutput "o" { value = "file \${local_file.one}" }`;

    const error = await planError(config);

    expect(error.message).toBe('local_file.one is an object and cannot be joined into a string');
    expect(error.position).toMatchObject(placeOf(config, 'local_file.one}'));
  });

  it('refuses an instance where an attribute takes a string', async () => {
    const config = `${single()}\nresource "local_file" "copy" {\n  path = "${at('copy')}"\n  content = local_file.one\n}`;

    const error = await planError(config);

    expect(error.message).toBe('content is an object, where local_file takes a string');
    expect(error.position).toMatchObject(placeOf(config, 'local_file.one\n}'));
  });

  // No instance is read, so only the type the reference will have can refuse it.
  it('refuses an instance where an attribute takes a string, in a block that makes no instance', async () => {
    const config = `${single()}\nresource "local_file" "none" {\n  count = 0\n  path = "${at('none')}"\n  content = local_file.one\n}`;

    const error = await planError(config);

    expect(error.message).toBe('content is an object, where local_file takes a string');
    expect(error.position).toMatchObject(placeOf(config, 'local_file.one\n}'));
  });
});

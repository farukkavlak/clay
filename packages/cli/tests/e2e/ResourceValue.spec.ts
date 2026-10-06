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
    ['an attribute of a resource that has count, with no index', 'local_file.logs.content', 'local_file.logs has count, so name one of it by index, as in local_file.logs[0]'],
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

  describe('every instance of a resource', () => {
    it('gives a list in index order under count, and a map by key under for_each', async () => {
      await apply(`${counted()}\n${keyed()}\noutput "logs" { value = local_file.logs }\noutput "f" { value = local_file.f }`);

      const [zero, one] = [0, 1].map((index) => path.join(dir, `log-${index}.txt`));
      expect(await outputs()).toEqual({
        logs: {
          value: [
            { id: zero, path: zero, content: 'log 0' },
            { id: one, path: one, content: 'log 1' },
          ],
          type: types.list(FILE),
        },
        f: { value: { a: { id: at('a'), path: at('a'), content: 'a' }, b: { id: at('b'), path: at('b'), content: 'b' } }, type: types.map(FILE) },
      });
    });

    it('gives an empty list where count is 0', async () => {
      await apply(`resource "local_file" "none" {\n  count = 0\n  path = "${at('none')}"\n  content = "x"\n}\noutput "none" { value = local_file.none }`);

      expect((await outputs())!.none).toEqual({ value: [], type: types.list(FILE) });
    });

    it('feeds a for_each, one instance for each it gives', async () => {
      await apply(
        `${keyed()}\nresource "local_file" "copy" {\n  for_each = local_file.f\n  path = "${path.join(dir, 'copy-${each.key}.txt')}"\n  content = "copy of \${each.value.content}"\n}`
      );

      expect(await fs.readFile(path.join(dir, 'copy-a.txt'), 'utf8')).toBe('copy of a');
      expect(await fs.readFile(path.join(dir, 'copy-b.txt'), 'utf8')).toBe('copy of b');
    });

    it('plans what the configuration sets as known and what the apply makes as unknown, in each instance', async () => {
      const { outputs: planned } = await newOrchestrator().plan('resource "random_string" "s" {\n  count = 2\n  length = 4\n}\noutput "s" { value = random_string.s }');

      const fresh = { id: UNKNOWN, length: ExactNumber.parse('4'), result: UNKNOWN, special: null };
      expect(planned.s.new?.value).toEqual([fresh, fresh]);
    });

    // Each instance keeps the types its own triggers hold, though the schema names them dynamic.
    it('holds instances whose dynamic attributes hold different types', async () => {
      await apply(
        'resource "null_resource" "n" {\n  for_each = { a = "text", b = 1 }\n  triggers = { v = each.value }\n}\noutput "v" { value = [for key, n in null_resource.n : n.triggers.v] }'
      );

      expect((await outputs())!.v.value).toEqual(['text', ExactNumber.parse('1')]);
    });

    // A data source is read at load, before any count is read.
    it('is not known yet to a data source', async () => {
      const config = `${counted()}\ndata "local_file" "d" {\n  path = "${at('d')}\${length(local_file.logs)}"\n}`;

      const error = await planError(config);

      expect(error.message).toBe('local_file.logs is known only once its count is read');
      expect(error.position).toMatchObject(placeOf(config, `"${at('d')}`));
    });
  });
});

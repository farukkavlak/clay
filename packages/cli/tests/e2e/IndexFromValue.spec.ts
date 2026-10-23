import { UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
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

/** The error a run is refused with. */
const errorOf = async (run: () => Promise<unknown>): Promise<ConfigError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

const DB = `
  output "secrets" {
    value     = ["one", "two"]
    sensitive = true
  }
  output "key" {
    value     = "a"
    sensitive = true
  }
  output "flag" {
    value     = true
    sensitive = true
  }
  output "negative" {
    value     = -1
    sensitive = true
  }
`;

const probe = (value: string, flag = '') => `
  module "db" { source = "./db" }
  variable "m" { default = { a = "x" } }
  variable "l" { default = ["x", "y"] }
  output "o" {
    value = ${value}${flag}
  }
`;

const randomRead = (read: string) => `
  resource "random_string" "r" { length = 1 }
  variable "l" { default = ["a", "b"] }
  output "o" { value = ${read} }
`;

const withRandom = (value: string) => `resource "random_string" "r" { length = 1 }\n${probe(value)}`;

describe('an index read from a value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    for await (const event of start(newOrchestrator(), config)) {
      if (event.type === 'failed') throw event.error;
      events.push(event);
    }
    return events;
  };

  /** Both the validate and the plan refuse it, at the same place. */
  const refused = async (config: string, message: string, needle: string) => {
    for (const run of [() => newOrchestrator().validate(config), () => newOrchestrator().plan(config)]) {
      const error = await errorOf(run);

      expect(error.message).toContain(message);
      expect(error.position).toMatchObject(placeOf(config, needle));
    }
  };

  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');

  const outputOf = async (config: string, name = 'o') => {
    const { outputs } = await newOrchestrator().plan(config);

    return outputs[name].new;
  };

  const file = (name: string) => `"${path.join(dir, name)}"`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-index-from-value-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('in a value', () => {
    it('takes the item of a list at count.index', async () => {
      await apply(`
        variable "l" { default = ["a", "b"] }
        resource "local_file" "f" {
          count   = 2
          path    = ${file('f-${count.index}.txt')}
          content = var.l[count.index]
        }
      `);

      expect([await read('f-0.txt'), await read('f-1.txt')]).toEqual(['a', 'b']);
    });

    it('takes the item of a list at a value worked out from count.index', async () => {
      await apply(`
        variable "l" { default = ["a", "b", "c"] }
        resource "local_file" "f" {
          count   = 2
          path    = ${file('f-${count.index}.txt')}
          content = var.l[count.index + 1]
        }
      `);

      expect([await read('f-0.txt'), await read('f-1.txt')]).toEqual(['b', 'c']);
    });

    it('takes the value of a map at each.key', async () => {
      await apply(`
        variable "m" { default = { x = "one", y = "two" } }
        resource "local_file" "f" {
          for_each = { x = 1, y = 2 }
          path     = ${file('f-${each.key}.txt')}
          content  = var.m[each.key]
        }
      `);

      expect([await read('f-x.txt'), await read('f-y.txt')]).toEqual(['one', 'two']);
    });

    it.each([
      ['a variable', 'var.i', 'variable "i" { default = 1 }'],
      ['a local', 'local.i', 'locals { i = 1 }'],
      ['a call', 'length(["a"])', ''],
      ['an index read from another value', 'var.ks[0]', 'variable "ks" { default = [1] }'],
    ])('takes the item a number from %s names', async (_, index, declared) => {
      expect(await outputOf(`${declared}\nvariable "l" { default = ["a", "b"] }\noutput "o" { value = var.l[${index}] }`)).toMatchObject({ value: 'b' });
    });

    it('takes the item of a for at the name it binds', async () => {
      const config = `
        variable "names" { default = ["a", "b"] }
        variable "other" { default = ["x", "y"] }
        output "o" { value = [for i, n in var.names : "${'${n}'}-${'${var.other[i]}'}"] }
      `;

      expect(await outputOf(config)).toMatchObject({ value: ['a-x', 'b-y'] });
    });

    it('takes the item of what a call gives', async () => {
      expect(await outputOf('variable "s" { default = ["b", "a"] }\noutput "o" { value = tolist(var.s)[length(["x"])] }')).toMatchObject({ value: 'a' });
    });

    it('takes a step into the part it found', async () => {
      const config = `
        variable "l" { default = [{ name = "a" }, { name = "b" }] }
        output "o" { value = var.l[length(["x"])].name }
      `;

      expect(await outputOf(config)).toMatchObject({ value: 'b' });
    });
  });

  describe('as the key of an instance', () => {
    it('reads the instance of a resource at count.index', async () => {
      await apply(`
        resource "local_file" "f" {
          count   = 2
          path    = ${file('f-${count.index}.txt')}
          content = "file ${'${count.index}'}"
        }
        resource "local_file" "g" {
          count   = 2
          path    = ${file('g-${count.index}.txt')}
          content = local_file.f[count.index].content
        }
      `);

      expect([await read('g-0.txt'), await read('g-1.txt')]).toEqual(['file 0', 'file 1']);
    });

    it('reads the instance of a resource at each.key', async () => {
      await apply(`
        resource "local_file" "f" {
          for_each = { x = 1, y = 2 }
          path     = ${file('f-${each.key}.txt')}
          content  = "file ${'${each.key}'}"
        }
        resource "local_file" "g" {
          for_each = { x = 1, y = 2 }
          path     = ${file('g-${each.key}.txt')}
          content  = local_file.f[each.key].content
        }
      `);

      expect([await read('g-x.txt'), await read('g-y.txt')]).toEqual(['file x', 'file y']);
    });

    it('reads the instance of a data source at count.index', async () => {
      await fs.writeFile(path.join(dir, 'in-0.txt'), 'zero', 'utf8');
      await fs.writeFile(path.join(dir, 'in-1.txt'), 'one', 'utf8');
      await apply(`
        data "local_file" "in" {
          count = 2
          path  = ${file('in-${count.index}.txt')}
        }
        resource "local_file" "out" {
          count   = 2
          path    = ${file('out-${count.index}.txt')}
          content = data.local_file.in[count.index].content
        }
      `);

      expect([await read('out-0.txt'), await read('out-1.txt')]).toEqual(['zero', 'one']);
    });

    it('reads the output of a module instance at count.index', async () => {
      await fs.mkdir(path.join(dir, 'm'));
      await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "n" {}\noutput "text" { value = "copy ${var.n}" }', 'utf8');
      await apply(`
        module "m" {
          source = "./m"
          count  = 2
          n      = count.index
        }
        resource "local_file" "out" {
          count   = 2
          path    = ${file('out-${count.index}.txt')}
          content = module.m[count.index].text
        }
      `);

      expect([await read('out-0.txt'), await read('out-1.txt')]).toEqual(['copy 0', 'copy 1']);
    });
  });

  describe('not known yet', () => {
    it('is a result not known yet in the plan, and known once the apply has the index', async () => {
      expect(await outputOf(randomRead('var.l[length(random_string.r.result)]'))).toMatchObject({ value: UNKNOWN });

      await apply(randomRead('var.l[length(random_string.r.result)]'));

      const { outputs } = await new LocalBackend(dir).read();

      expect(outputs?.o).toMatchObject({ value: 'b' });
    });

    it('waits for what the index reads, so the apply makes it first', async () => {
      const text = `
        resource "local_file" "src" {
          path    = ${file('src.txt')}
          content = "a"
        }
        variable "m" { default = { a = "found" } }
        resource "local_file" "dst" {
          path    = ${file('dst.txt')}
          content = var.m[local_file.src.content]
        }
      `;
      await apply(text);

      expect(await read('dst.txt')).toBe('found');
    });

    it('still checks the type the index can never have', async () => {
      await refused(randomRead('var.l[[random_string.r.result]]'), 'An index is a number or a string, not a tuple', '[random_string.r.result]');
    });
  });

  describe('refused', () => {
    it.each([
      ['past the end of the list', 'variable "l" { default = ["a", "b"] }', 'var.l[count.index]', 'var.l has no item [2]: it holds 2', 3],
      ['into a set', 'variable "l" { type = set(string)\n default = ["a"] }', 'var.l[count.index]', 'var.l is a set and has no item [0]: its members have no order', 1],
      ['to a key a map does not have', 'variable "l" { default = { a = "x" } }', 'var.l[var.k]', 'var.l has no key "b"', 1],
    ])('an index %s', async (_, declared, read, message, count) => {
      const config = `${declared}\nvariable "k" { default = "b" }\nresource "local_file" "f" {\n  count = ${count}\n  path = "f"\n  content = ${read}\n}`;

      await refused(config, message, read);
    });

    it.each([
      ['a negative number', '-1', 'An index is not negative'],
      ['a fraction', '1.5', 'An index is not a whole number'],
      ['a boolean', 'true', 'An index is a number or a string, not a boolean'],
      ['a tuple', '["a"]', 'An index is a number or a string, not a tuple'],
      ['null', 'null', 'An index is a number or a string, not null'],
    ])('%s as an index', async (_, given, message) => {
      const config = `variable "i" { default = ${given} }\nvariable "l" { default = ["a"] }\noutput "o" { value = var.l[var.i] }`;

      await refused(config, message, 'var.i]');
    });

    it('count.index where the block has no count', async () => {
      const config = 'variable "l" { default = ["a"] }\nresource "local_file" "f" {\n  path = "f"\n  content = var.l[count.index]\n}';

      await refused(config, 'count.index is only known inside', 'count.index');
    });

    it.each([
      [
        'a resource',
        'resource "local_file" "f" {\n  path = "f"\n  content = "x"\n}',
        'local_file.f[var.i].content',
        'local_file.f has neither count nor for_each, so it takes no index',
      ],
      [
        'an instance past its count',
        'resource "local_file" "f" {\n  count = 2\n  path = "f"\n  content = "x"\n}',
        'local_file.f[var.i].content',
        'local_file.f has 2 instances, [0] to [1]',
      ],
      [
        'a for_each block, by a number',
        'resource "local_file" "f" {\n  for_each = { a = 1 }\n  path = "f"\n  content = "x"\n}',
        'local_file.f[var.i].content',
        'local_file.f has for_each, so name one of it by key, as in local_file.f["key"]',
      ],
      [
        'a count block, by a string',
        'resource "local_file" "f" {\n  count = 2\n  path = "f"\n  content = "x"\n}',
        'local_file.f[var.k].content',
        'local_file.f has count, so name one of it by index, as in local_file.f[0]',
      ],
      [
        'an instance a for_each does not make',
        'resource "local_file" "f" {\n  for_each = { a = 1 }\n  path = "f"\n  content = "x"\n}',
        'local_file.f[var.k].content',
        'local_file.f has no instance ["b"], only ["a"]',
      ],
    ])('an index in %s', async (_, block, read, message) => {
      const config = `variable "i" { default = 2 }\nvariable "k" { default = "b" }\n${block}\noutput "o" { value = ${read} }`;

      await refused(config, message, read);
    });

    it('an index past the instances of a data source', async () => {
      await fs.writeFile(path.join(dir, 'in-0.txt'), 'zero', 'utf8');
      await fs.writeFile(path.join(dir, 'in-1.txt'), 'one', 'utf8');
      const read = 'data.local_file.d[var.i].content';
      const config = `variable "i" { default = 2 }\ndata "local_file" "d" {\n  count = 2\n  path = ${file('in-${count.index}.txt')}\n}\noutput "o" { value = ${read} }`;

      await refused(config, 'data.local_file.d has 2 instances, [0] to [1]', read);
    });

    it('a key a module does not make', async () => {
      await fs.mkdir(path.join(dir, 'm'));
      await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "text" { value = "x" }', 'utf8');
      const read = 'module.m[var.k].text';
      const config = `variable "k" { default = "b" }\nmodule "m" {\n  source = "./m"\n  for_each = { a = 1 }\n}\noutput "o" { value = ${read} }`;

      await refused(config, 'module.m has no instance ["b"], only ["a"]', read);
    });

    it('an index that names itself through its own block', async () => {
      const config = 'resource "local_file" "f" {\n  count = 1\n  path = "f"\n  content = var.l[local_file.f[0].content]\n}\nvariable "l" { default = ["a"] }';

      await expect(newOrchestrator().validate(config)).rejects.toThrow(/cycle|depends on itself/i);
    });
  });

  describe('sensitive', () => {
    const REFUSED = 'output "o" holds a sensitive value; write sensitive = true to export it';

    it('is what a sensitive collection gives at a plain index', async () => {
      await expect(newOrchestrator().plan(probe('module.db.secrets[0]'))).rejects.toThrow(REFUSED);
    });

    it('is what a plain collection gives at a sensitive index', async () => {
      await expect(newOrchestrator().plan(probe('var.m[module.db.key]'))).rejects.toThrow(REFUSED);
      await expect(newOrchestrator().validate(probe('var.m[module.db.key]'))).rejects.toThrow(REFUSED);

      expect(await outputOf(probe('var.m[module.db.key]', '\nsensitive = true'))).toMatchObject({ value: 'x', sensitive: true });
    });

    it('is what a read at an index not known yet gives, when the index or the collection is', async () => {
      const unknown = 'length(random_string.r.result)';

      await expect(newOrchestrator().plan(withRandom(`module.db.secrets[${unknown}]`))).rejects.toThrow(REFUSED);
      await expect(newOrchestrator().plan(withRandom('var.m[sensitive(random_string.r.result)]'))).rejects.toThrow(REFUSED);
    });

    it('is not an index that is unknown and plain over a plain collection', async () => {
      const text = `resource "random_string" "r" { length = 1 }\n${probe('var.l[length(random_string.r.result)]')}`;

      expect(await outputOf(text)).toMatchObject({ value: UNKNOWN });
    });

    it('hides a key a sensitive index does not find', async () => {
      const text = probe('var.m[module.db.key]', '\nsensitive = true').replace('default = { a = "x" }', 'default = { b = "x" }');
      const error = await errorOf(() => newOrchestrator().plan(text));

      expect(error.message).toContain('var.m[module.db.key] was read at a sensitive index, so why it failed is not shown');
      expect(error.message).not.toContain('"a"');
    });

    it.each([
      ['negative', 'module.db.negative', 'module.db.negative'],
      ['a boolean', 'module.db.flag', 'module.db.flag'],
      ['worked out, with no name', 'module.db.negative * 2', "The value inside '['"],
    ])('does not say why a sensitive index is no index: %s', async (_, index, named) => {
      const error = await errorOf(() => newOrchestrator().plan(probe(`var.l[${index}]`, '\nsensitive = true')));

      expect(error.message).toContain(`${named} is sensitive and is no index: why is not shown`);
      expect(error.message).not.toMatch(/not negative|a boolean/);
    });

    it('stays sensitive when what a sensitive index reads is not known yet', async () => {
      const text = `
        module "db" { source = "./db" }
        resource "random_string" "r" {
          for_each = { a = 1 }
          length   = 1
        }
        output "o" { value = random_string.r[module.db.key].result }
      `;

      await expect(newOrchestrator().plan(text)).rejects.toThrow(REFUSED);
    });

    it('stays sensitive when an index not known yet reads a collection not known yet that is sensitive', async () => {
      const text = `
        resource "random_string" "r" { length = 1 }
        locals { secret = sensitive(random_string.r.result) }
        output "o" { value = local.secret[length(random_string.r.result)] }
      `;

      await expect(newOrchestrator().plan(text)).rejects.toThrow(REFUSED);
    });

    it('hides the instance a sensitive index does not find', async () => {
      const text = `
        module "db" { source = "./db" }
        resource "local_file" "f" {
          for_each = { b = 1 }
          path     = ${file('f.txt')}
          content  = "x"
        }
        output "o" {
          value     = local_file.f[module.db.key].content
          sensitive = true
        }
      `;
      const error = await errorOf(() => newOrchestrator().plan(text));

      expect(error.message).toContain('was read at a sensitive index, so why it failed is not shown');
      expect(error.message).not.toContain('["a"]');
    });
  });
});

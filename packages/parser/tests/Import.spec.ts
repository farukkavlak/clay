import { describe, expect, it } from 'vitest';

import { ConfigError, ImportBlock, parseModule } from '../src';

const parse = (...contents: string[]) => parseModule(contents.map((content, index) => ({ file: `f${index}.clay`, content })));

const errorOf = (...contents: string[]): ConfigError => {
  try {
    parse(...contents);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

const imported = (to: string, id = '"/tmp/a.txt"') => `import {\n  to = ${to}\n  id = ${id}\n}`;

describe('Parser - import block', () => {
  it.each([
    ['a resource', 'local_file.a'],
    ['an instance by index', 'local_file.a[0]'],
    ['an instance by key', 'local_file.a["web"]'],
  ])('reads %s as the address and the id as written', (_, to) => {
    const [block] = parse(imported(to)) as ImportBlock[];

    expect([block.type, block.to.toString(), block.id, block.position.line]).toEqual(['Import', to, '/tmp/a.txt', 1]);
  });

  it('refuses two imports to one address, across files', () => {
    const error = errorOf(imported('local_file.a'), imported('local_file.a', '"/tmp/b.txt"'));

    expect([error.message, error.position.file]).toEqual(['import to local_file.a is declared twice, first on f0.clay line 1', 'f1.clay']);
  });

  it('takes imports to two instances of one resource', () => {
    expect(parse(imported('local_file.a[0]'), imported('local_file.a[1]'))).toHaveLength(2);
  });

  it.each([
    ['no to', 'import {\n  id = "x"\n}', 'import needs a "to"', [1, 1]],
    ['no id', 'import {\n  to = local_file.a\n}', 'import needs an "id"', [1, 1]],
    ['another attribute', 'import {\n  to = local_file.a\n  from = local_file.b\n}', 'import takes only "to" and "id", not "from".', [3, 10]],
    ['an attribute twice', 'import {\n  to = local_file.a\n  to = local_file.b\n}', 'to is set twice', [3, 3]],
    ['a block inside', 'import {\n  lifecycle {}\n}', "Expect '=' after attribute name.", [2, 13]],
    ['a label', 'import "x" {\n}', "Expect '{' after 'import'.", [1, 8]],
    ['a string as the address', imported('"local_file.a"'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['a key read from a value', imported('local_file.a[var.i]'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['a module call', imported('module.m'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['a resource in a module', imported('module.m.local_file.a'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['a data source', imported('data.local_file.a'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['a path into an attribute', imported('local_file.a.path'), 'import "to" is a resource of the root module or an instance of one', [2, 8]],
    ['an id read from a value', imported('local_file.a', 'var.id'), 'import "id" is a string written out, as in "/tmp/a.txt"', [3, 8]],
    ['an id with a template', imported('local_file.a', '"/tmp/${var.name}"'), 'import "id" is a string written out, as in "/tmp/a.txt"', [3, 8]],
    ['a number as the id', imported('local_file.a', '1'), 'import "id" is a string written out, as in "/tmp/a.txt"', [3, 8]],
    ['an empty id', imported('local_file.a', '""'), 'import "id" must not be empty', [3, 8]],
  ])('refuses %s where it is written', (_, source, message, [line, column]) => {
    const error = errorOf(source);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line, column });
  });
});

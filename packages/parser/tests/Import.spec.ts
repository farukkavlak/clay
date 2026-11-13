import { describe, expect, it } from 'vitest';

import { ConfigError, ImportBlock, parseModule, spell } from '../src';

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
const each = (to: string) => `import {\n  for_each = var.files\n  to = ${to}\n  id = each.value\n}`;

describe('Parser - import block', () => {
  it.each([
    ['a resource', 'local_file.a'],
    ['an instance by index', 'local_file.a[0]'],
    ['an instance by key', 'local_file.a["web"]'],
    ['a resource in a module', 'module.m.local_file.a'],
    ['an instance in a module instance', 'module.m[0].local_file.a["web"]'],
    ['a resource two modules deep', 'module.a["x"].module.b.local_file.a'],
  ])('reads %s as the address and the id as written', (_, to) => {
    const [block] = parse(imported(to)) as ImportBlock[];

    expect([block.type, block.to.toString(), block.id, block.position.line]).toEqual([
      'Import',
      to,
      { type: 'String', value: '/tmp/a.txt', position: expect.objectContaining({ line: 3, column: 8 }) },
      1,
    ]);
  });

  it('keeps an id read from a value as the expression, for the plan to read', () => {
    const [block] = parse(imported('local_file.a', 'var.id')) as ImportBlock[];

    expect(block.id.type).toBe('Reference');
  });

  it('refuses two imports to one address, across files', () => {
    const error = errorOf(imported('local_file.a'), imported('local_file.a', '"/tmp/b.txt"'));

    expect([error.message, error.position.file]).toEqual(['import to local_file.a is declared twice, first on f0.clay line 1', 'f1.clay']);
  });

  it('reads for_each, and a key read from each as written', () => {
    const [block] = parse(each('local_file.a[upper(each.key)]')) as ImportBlock[];

    expect([block.to.toString(), block.keys.map(({ part, spelled }) => [part, spelled]), block.forEach?.type, block.id.type, spell(block)]).toEqual([
      'local_file.a',
      [[0, 'upper(...)']],
      'Reference',
      'Reference',
      'import to local_file.a[upper(...)]',
    ]);
  });

  it.each([
    ['a module call', 'module.m[each.key].local_file.a', 'module.m.local_file.a', [0]],
    ['a module call and the resource', 'module.m[each.key].local_file.a[each.value]', 'module.m.local_file.a', [0, 1]],
    ['a module call two deep, under a key written out', 'module.a[0].module.b[each.key].local_file.a', 'module.a[0].module.b.local_file.a', [1]],
  ])('reads a key read from each in %s, at the part it keys', (_, to, address, parts) => {
    const [block] = parse(each(to)) as ImportBlock[];

    expect([block.to.toString(), block.keys.map(({ part }) => part), spell(block)]).toEqual([address, parts, `import to ${to}`]);
  });

  it('takes two imports with for_each to one resource, since the plan tells their addresses apart', () => {
    expect(parse(each('local_file.a[each.key]'), each('local_file.a[each.key]'))).toHaveLength(2);
  });

  it('takes imports to two instances of one resource', () => {
    expect(parse(imported('local_file.a[0]'), imported('local_file.a[1]'))).toHaveLength(2);
  });

  it('refuses two imports to one address in a module', () => {
    expect(errorOf(imported('module.m[0].local_file.a'), imported('module.m[0].local_file.a')).message).toBe(
      'import to module.m[0].local_file.a is declared twice, first on f0.clay line 1'
    );
  });

  it.each([
    ['no to', 'import {\n  id = "x"\n}', 'import needs a "to"', [1, 1]],
    ['no id', 'import {\n  to = local_file.a\n}', 'import needs an "id"', [1, 1]],
    ['another attribute', 'import {\n  to = local_file.a\n  from = local_file.b\n}', 'import takes only "to", "id" and "for_each", not "from".', [3, 10]],
    ['an attribute twice', 'import {\n  to = local_file.a\n  to = local_file.b\n}', 'to is set twice', [3, 3]],
    ['a block inside', 'import {\n  lifecycle {}\n}', "Expect '=' after attribute name.", [2, 13]],
    ['a label', 'import "x" {\n}', "Expect '{' after 'import'.", [1, 8]],
    ['a string as the address', imported('"local_file.a"'), 'import "to" is a resource or an instance of one', [2, 8]],
    ['a key read from each with no for_each', imported('local_file.a[each.key]'), 'import "to" reads its key from each, which only for_each gives', [2, 8]],
    ['a key that reads more than each', each('local_file.a[var.i]'), 'import "to" reads only each in its key, as in local_file.a[each.key]', [3, 21]],
    ['a key read from each after a key', each('local_file.a[0][each.key]'), 'import "to" is a resource or an instance of one', [3, 8]],
    ['a module call', imported('module.m'), 'import "to" is a resource or an instance of one', [2, 8]],
    ['a key read from each after the word module', each('module[each.key].m.local_file.a'), 'import "to" is a resource or an instance of one', [3, 8]],
    ['a key read from each after the type', each('module.m.local_file[each.key].a'), 'import "to" is a resource or an instance of one', [3, 8]],
    ['a key read from each after a module key', each('module.m[0][each.key].local_file.a'), 'import "to" is a resource or an instance of one', [3, 8]],
    ['a key in a module call that reads more than each', each('module.m[var.i].local_file.a'), 'import "to" reads only each in its key, as in local_file.a[each.key]', [3, 17]],
    [
      'a key in a module call read from each with no for_each',
      imported('module.m[each.key].local_file.a'),
      'import "to" reads its key from each, which only for_each gives',
      [2, 8],
    ],
    ['a data source in a module', imported('module.m.data.local_file.a'), 'import "to" is a resource or an instance of one', [2, 8]],
    ['a data source', imported('data.local_file.a'), 'import "to" is a resource or an instance of one', [2, 8]],
    ['a path into an attribute', imported('local_file.a.path'), 'import "to" is a resource or an instance of one', [2, 8]],
  ])('refuses %s where it is written', (_, source, message, [line, column]) => {
    const error = errorOf(source);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line, column });
  });
});

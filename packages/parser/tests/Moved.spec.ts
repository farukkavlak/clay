import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ConfigError, MovedBlock, Parser } from '../src';
import { Lexer } from '../src/Lexer';

const parse = (source: string) => new Parser(new Lexer(source, CONFIG_FILE).tokenize()).parse();

const errorOf = (source: string): ConfigError => {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

const moved = (from: string, to: string) => `moved {\n  from = ${from}\n  to = ${to}\n}`;
const ends = (source: string) => {
  const { from, to } = parse(source)[0] as MovedBlock;
  return [from.toString(), to.toString()];
};

describe('Parser - moved block', () => {
  it.each([
    ['a resource', 'local_file.a', 'local_file.b'],
    ['an instance by index and by key', 'local_file.a[0]', 'local_file.a["web"]'],
    ['a resource in a module instance', 'module.m[1].local_file.a', 'module.n["x"].local_file.a'],
  ])('reads %s on each side as an address', (_, from, to) => {
    expect(ends(moved(from, to))).toEqual([from, to]);
  });

  it('is placed at the block, and two blocks are not a duplicate', () => {
    const program = parse(`${moved('local_file.a', 'local_file.b')}\n${moved('local_file.c', 'local_file.d')}`);

    expect(program.map((statement) => [statement.type, statement.position.line])).toEqual([
      ['Moved', 1],
      ['Moved', 5],
    ]);
  });

  it.each([
    ['no to', 'moved {\n  from = local_file.a\n}', 'moved needs a "to"', [1, 1]],
    ['no from', 'moved {\n  to = local_file.a\n}', 'moved needs a "from"', [1, 1]],
    ['another attribute', 'moved {\n  from = local_file.a\n  by = local_file.b\n}', 'moved takes only "from" and "to", not "by".', [3, 8]],
    ['an attribute twice', 'moved {\n  from = local_file.a\n  from = local_file.b\n}', 'from is set twice', [3, 3]],
    ['a block inside', 'moved {\n  lifecycle {}\n}', "Expect '=' after attribute name.", [2, 13]],
    ['a label', 'moved "x" {\n}', "Expect '{' after 'moved'.", [1, 7]],
    ['a string', moved('"local_file.a"', 'local_file.b'), 'moved "from" is a resource or one of its instances', [2, 10]],
    ['a key read from a value', moved('local_file.a[var.i]', 'local_file.b'), 'moved "from" is a resource or one of its instances', [2, 10]],
    ['a call', moved('local_file.a', 'f(local_file.b)'), 'moved "to" is a resource or one of its instances', [3, 8]],
    ['a data source', moved('data.local_file.a', 'local_file.b'), 'moved "from" is a resource or one of its instances', [2, 10]],
    ['a module alone', moved('module.a', 'module.b'), 'moved "from" is a resource or one of its instances', [2, 10]],
    ['a path into an attribute', moved('local_file.a', 'local_file.b.path'), 'moved "to" is a resource or one of its instances', [3, 8]],
    ['the same address on both sides', moved('local_file.a[0]', 'local_file.a[0]'), 'moved from local_file.a[0] to the same address moves nothing', [1, 1]],
    ['another type', moved('local_file.a', 'other_file.a'), 'moved from local_file.a to other_file.a changes the type', [3, 8]],
  ])('refuses %s where it is written', (_, source, message, [line, column]) => {
    const error = errorOf(source);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line, column });
  });
});

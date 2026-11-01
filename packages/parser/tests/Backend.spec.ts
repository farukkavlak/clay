import { describe, expect, it } from 'vitest';

import { BackendBlock, ConfigError, parseModule } from '../src';

const parse = (...contents: string[]) => parseModule(contents.map((content, index) => ({ file: `${index}.clay`, content })));

const errorOf = (...contents: string[]): ConfigError => {
  try {
    parse(...contents);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

describe('Parser - clay block', () => {
  it('reads a backend with its type and its attributes', () => {
    const [backend] = parse('clay {\n  backend "local" {\n    path = "a.json"\n  }\n}') as BackendBlock[];

    expect(backend).toMatchObject({
      type: 'Backend',
      backendType: { value: 'local', position: { line: 2, column: 11 } },
      attributes: { path: { type: 'String', value: 'a.json' } },
      position: { line: 2, column: 3 },
    });
  });

  it('gives no statement for one with no backend', () => {
    expect(parse('clay {}')).toEqual([]);
  });

  it.each([
    ['in one block', ['clay {\n  backend "a" {}\n  backend "b" {}\n}'], '0.clay', 3],
    ['in two blocks', ['clay {\n  backend "a" {}\n}\nclay {\n  backend "b" {}\n}'], '0.clay', 5],
    ['in two files', ['clay {\n  backend "a" {}\n}', 'clay {\n  backend "b" {}\n}'], '1.clay', 2],
  ])('refuses two backends %s, at the second', (_title, contents, file, line) => {
    const error = errorOf(...contents);

    expect(error.message).toBe('a backend is declared twice, first on 0.clay line 2');
    expect(error.position).toMatchObject({ file, line });
  });

  it.each([
    ['a reference', 'var.p', 'path of backend "local" is a constant, so it cannot hold var.p', 12],
    ['a call', 'upper("x")', 'path of backend "local" is a constant, so it cannot hold upper(...)', 12],
    ['a reference in a string', '"${var.p}"', 'path of backend "local" is a constant, so it cannot hold var.p', 15],
  ])('refuses %s as a value of a backend, where it is written', (_title, value, message, column) => {
    const error = errorOf(`clay { backend "local" {\n  path = ${value}\n} }`);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line: 2, column: column - 2 });
  });

  it.each([
    ['an attribute in clay', 'clay {\n  x = 1\n}', 'clay takes only a backend block', 2, 7],
    ['another block in clay', 'clay {\n  thing {}\n}', 'clay takes only a backend block', 2, 3],
    ['a label on clay', 'clay "x" {}', "Expect '{' after 'clay'.", 1, 6],
    ['a backend with no type', 'clay {\n  backend {}\n}', "Expect backend type string after 'backend'.", 2, 11],
    ['a backend with two labels', 'clay {\n  backend "a" "b" {}\n}', "Expect '{' after backend type.", 2, 15],
    ['a block in a backend', 'clay {\n  backend "a" {\n    inner {}\n  }\n}', "Expect '=' after attribute name.", 3, 11],
    ['a name twice in a backend', 'clay {\n  backend "a" {\n    p = 1\n    p = 2\n  }\n}', 'p is set twice', 4, 5],
  ])('refuses %s', (_title, source, message, line, column) => {
    const error = errorOf(source);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line, column });
  });
});

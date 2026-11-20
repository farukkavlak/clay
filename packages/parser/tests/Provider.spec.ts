import { describe, expect, it } from 'vitest';

import { ConfigError, parseModule, ProviderBlock } from '../src';

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

describe('Parser - provider block', () => {
  it('reads a provider with its name and its arguments', () => {
    const [provider] = parse('provider "local" {\n  region = var.region\n}') as ProviderBlock[];

    expect(provider).toMatchObject({
      type: 'Provider',
      name: 'local',
      attributes: { region: { type: 'Reference', value: [{ name: 'var' }, { name: 'region' }] } },
      position: { line: 1, column: 1 },
    });
  });

  it('refuses two blocks for one provider, at the second', () => {
    const error = errorOf('provider "local" {}', 'provider "local" {}');

    expect(error.message).toBe('provider "local" is declared twice, first on 0.clay line 1');
    expect(error.position).toMatchObject({ file: '1.clay', line: 1 });
  });

  it('reads an alias apart from the arguments', () => {
    const [, provider] = parse('provider "local" {}', 'provider "local" {\n  alias = "west"\n  region = "us"\n}') as ProviderBlock[];

    expect(provider).toMatchObject({ name: 'local', alias: { value: 'west', position: { file: '1.clay', line: 2 } } });
    expect(Object.keys(provider.attributes)).toEqual(['region']);
  });

  it('refuses two blocks with one alias, at the second', () => {
    const error = errorOf('provider "local" { alias = "west" }', 'provider "local" { alias = "west" }');

    expect(error.message).toBe('provider "local" alias "west" is declared twice, first on 0.clay line 1');
    expect(error.position).toMatchObject({ file: '1.clay', line: 1 });
  });

  it.each([
    ['an alias that is not written out', 'provider "a" {\n  alias = var.x\n}', 'alias is a name in quotes, as in alias = "west"'],
    ['an alias that is no name', 'provider "a" {\n  alias = "a.b"\n}', 'Invalid alias "a.b": an alias starts with'],
  ])('refuses %s, where it is written', (_title, content, message) => {
    const error = errorOf(content);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line: 2, column: 11 });
  });

  it.each([
    ['resource', 'resource "local_file" "f" {\n  provider = local.west\n}'],
    ['data source', 'data "local_file" "f" {\n  provider = local.west\n}'],
  ])('reads the instance a %s names, apart from its arguments', (_kind, block) => {
    const [, statement] = parse('provider "local" { alias = "west" }', block);

    expect(statement).toMatchObject({ provider: { name: 'local', alias: 'west', position: { file: '1.clay', line: 2, column: 14 } }, attributes: {} });
  });

  it('reads a provider named with no alias as the default instance, which needs no block', () => {
    const [statement] = parse('resource "local_file" "f" {\n  provider = local\n}');

    expect(statement).toMatchObject({ provider: { name: 'local' } });
    expect(Object.hasOwn((statement as { provider: object }).provider, 'alias')).toBe(false);
  });

  it.each([
    ['a string', '"local"'],
    ['three steps', 'local.west.x'],
    ['an index', 'local[0]'],
  ])('refuses a provider written as %s, where it is written', (_title, value) => {
    const error = errorOf(`resource "local_file" "f" {\n  provider = ${value}\n}`);

    expect(error.message).toBe('provider names a provider and, for a second instance, its alias, as in provider = local.west');
    expect(error.position).toMatchObject({ line: 2, column: 14 });
  });

  it.each([
    ['no name', 'provider {}', "Expect provider name string after 'provider'.", 10],
    ['a name that is no identifier', 'provider "a.b" {}', 'Invalid name "a.b": a name', 10],
    ['a second label', 'provider "a" "b" {}', "Expect '{' after provider name.", 14],
    ['a block inside', 'provider "a" {\n  inner {}\n}', "Expect '=' after attribute name.", 9],
  ])('refuses %s', (_title, content, message, column) => {
    const error = errorOf(content);

    expect(error.message).toContain(message);
    expect(error.position.column).toBe(column);
  });
});

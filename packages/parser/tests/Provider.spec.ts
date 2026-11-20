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

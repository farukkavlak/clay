import { describe, expect, it } from 'vitest';

import { ConfigError, Parser, ResourceBlock } from '../src';
import { Lexer } from '../src/Lexer';

const parse = (source: string) => new Parser(new Lexer(source, 'main.clay').tokenize()).parse();
const resource = (source: string) => parse(source)[0] as ResourceBlock;

const errorOf = (source: string): ConfigError => {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

const ignored = (value: string) => resource(`resource "t" "a" { lifecycle { ignore_changes = ${value} } }`).lifecycle?.ignoreChanges;

describe('Parser - lifecycle block', () => {
  it.each([true, false])('reads prevent_destroy = %s apart from the attributes', (value) => {
    const block = resource(`resource "local_file" "a" {\n  path = "a"\n  lifecycle {\n    prevent_destroy = ${value}\n  }\n}`);

    expect(block.lifecycle).toMatchObject({ preventDestroy: value, position: { line: 3, column: 3 } });
    expect(Object.keys(block.attributes)).toEqual(['path']);
  });

  it('is left out of a resource without one, and holds no flag where the block is empty', () => {
    expect(resource('resource "local_file" "a" { path = "a" }').lifecycle).toBeUndefined();
    expect(resource('resource "local_file" "a" { lifecycle {} }').lifecycle).not.toHaveProperty('preventDestroy');
  });

  it.each([true, false])('reads create_before_destroy = %s beside the other arguments', (value) => {
    const { lifecycle } = resource(`resource "t" "a" { lifecycle { create_before_destroy = ${value} prevent_destroy = true } }`);

    expect(lifecycle).toMatchObject({ createBeforeDestroy: value, preventDestroy: true });
  });

  describe('ignore_changes', () => {
    it('is all, written alone', () => {
      expect(ignored('all')).toBe('all');
    });

    it('is a list of paths: an attribute, then keys and indexes, each where it was written', () => {
      expect(ignored('[content, tags["Name"], items[0].size]')).toEqual([
        { path: ['content'], position: { file: 'main.clay', line: 1, column: 50 } },
        { path: ['tags', 'Name'], position: { file: 'main.clay', line: 1, column: 59 } },
        { path: ['items', 0, 'size'], position: { file: 'main.clay', line: 1, column: 73 } },
      ]);
    });

    it('is an empty list, and left out where the block does not say it', () => {
      expect(ignored('[]')).toEqual([]);
      expect(resource('resource "t" "a" { lifecycle { prevent_destroy = true } }').lifecycle).not.toHaveProperty('ignoreChanges');
    });

    it('may stand beside prevent_destroy', () => {
      const { lifecycle } = resource('resource "t" "a" { lifecycle { prevent_destroy = true ignore_changes = [x] } }');

      expect(lifecycle).toMatchObject({ preventDestroy: true, ignoreChanges: [{ path: ['x'] }] });
    });
  });

  it('is no block where the name is one every object has', () => {
    expect(errorOf('resource "t" "a" { toString {} }').message).toContain("Expect '='");
  });

  it('is an attribute where it is written with an equals sign', () => {
    const block = resource('resource "local_file" "a" { lifecycle = "x" }');

    expect(block.lifecycle).toBeUndefined();
    expect(Object.keys(block.attributes)).toEqual(['lifecycle']);
  });

  it.each([
    [
      'an argument it does not take',
      'resource "t" "a" { lifecycle { replace_triggered_by = true } }',
      'lifecycle takes only "prevent_destroy", "create_before_destroy" and "ignore_changes", not "replace_triggered_by"',
      1,
      32,
    ],
    ['create_before_destroy that is not written out', 'resource "t" "a" { lifecycle { create_before_destroy = var.x } }', 'create_before_destroy is true or false.', 1, 56],
    ['create_before_destroy twice', 'resource "t" "a" { lifecycle { create_before_destroy = true create_before_destroy = false } }', 'create_before_destroy is set twice', 1, 61],
    ['ignore_changes that is not a list or all', 'resource "t" "a" { lifecycle { ignore_changes = "x" } }', 'ignore_changes is a list of attributes, or all.', 1, 49],
    ['an ignored attribute in quotes', 'resource "t" "a" { lifecycle { ignore_changes = ["x"] } }', 'ignore_changes names an attribute, written without quotes.', 1, 50],
    ['all in a list', 'resource "t" "a" { lifecycle { ignore_changes = [x, all] } }', 'all is written alone, not in a list', 1, 53],
    ['a reference as a key', 'resource "t" "a" { lifecycle { ignore_changes = [x[var.k]] } }', 'ignore_changes names keys and indexes written out, not a value to read', 1, 50],
    ['an operator as an index', 'resource "t" "a" { lifecycle { ignore_changes = [x[0 + 1]] } }', 'ignore_changes names keys and indexes written out, not a value to read', 1, 50],
    ['ignore_changes twice', 'resource "t" "a" { lifecycle { ignore_changes = [] ignore_changes = [] } }', 'ignore_changes is set twice', 1, 52],
    ['a value that is not written out', 'resource "t" "a" { lifecycle { prevent_destroy = var.x } }', 'prevent_destroy is true or false.', 1, 50],
    ['the same argument twice', 'resource "t" "a" { lifecycle { prevent_destroy = true prevent_destroy = false } }', 'prevent_destroy is set twice', 1, 55],
    ['two lifecycle blocks', 'resource "t" "a" { lifecycle {} lifecycle {} }', 'resource "t" "a" has two lifecycle blocks', 1, 33],
  ])('refuses %s', (_, source, message, line, column) => {
    const error = errorOf(source);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject({ line, column });
  });

  it('is refused in a block that has no lifecycle', () => {
    expect(errorOf('data "local_file" "a" { lifecycle { prevent_destroy = true } }').message).toContain('Expect');
  });
});

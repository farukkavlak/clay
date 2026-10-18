import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ConfigError, Parser, ResourceBlock } from '../src';
import { Lexer } from '../src/Lexer';

const parse = (source: string) => new Parser(new Lexer(source, CONFIG_FILE).tokenize()).parse();
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

  it('is no block where the name is one every object has', () => {
    expect(errorOf('resource "t" "a" { toString {} }').message).toContain("Expect '='");
  });

  it('is an attribute where it is written with an equals sign', () => {
    const block = resource('resource "local_file" "a" { lifecycle = "x" }');

    expect(block.lifecycle).toBeUndefined();
    expect(Object.keys(block.attributes)).toEqual(['lifecycle']);
  });

  it.each([
    ['an argument it does not take', 'resource "t" "a" { lifecycle { ignore_changes = true } }', 'lifecycle takes only "prevent_destroy", not "ignore_changes"', 1, 32],
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

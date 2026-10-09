import { describe, expect, it } from 'vitest';

import { CONFIG_FILE } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';
import { steps } from './steps';

const parse = (input: string) => new Parser(new Lexer(input, CONFIG_FILE).tokenize()).parse();
const at = (line: number, column: number) => ({ file: CONFIG_FILE, line, column });

function errorOf(input: string): ConfigError {
  try {
    parse(input);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${input}`);
}

describe('a locals block', () => {
  it('is a statement for each name, placed at the name', () => {
    expect(parse('locals {\n  a = "x"\n  b = local.a\n}')).toEqual([
      { type: 'Local', name: 'a', value: { type: 'String', value: 'x', position: at(2, 7) }, position: at(2, 3) },
      { type: 'Local', name: 'b', value: { type: 'Reference', value: steps('local', 'a'), position: at(3, 7) }, position: at(3, 3) },
    ]);
  });

  it('merges with another, in the order they are written', () => {
    const program = parse('locals { a = 1 }\nresource "t" "n" {}\nlocals { b = 2 }');

    expect(program.map((statement) => `${statement.type} ${statement.name}`)).toEqual(['Local a', 'Resource n', 'Local b']);
  });

  it('may hold no name', () => {
    expect(parse('locals {}')).toEqual([]);
  });

  it.each([
    ['in one block', 'locals {\n  a = 1\n  a = 2\n}', at(3, 3)],
    ['in two blocks', 'locals { a = 1 }\nlocals { a = 2 }', at(2, 10)],
  ])('refuses a name set twice %s, at the second', (_, input, position) => {
    const error = errorOf(input);

    expect(error.message).toBe('local "a" is declared twice');
    expect(error.position).toEqual(position);
  });

  it('may be named like a variable or an output', () => {
    const program = parse('variable "a" { default = 1 }\nlocals { a = 2 }\noutput "a" { value = 3 }');

    expect(program.map((statement) => statement.type)).toEqual(['Variable', 'Local', 'Output']);
  });

  it.each([
    ['a label', 'locals "a" {}', "Expect '{' after 'locals'.", at(1, 8)],
    ['a name with no value', 'locals { a }', "Expect '=' after the name of a local.", at(1, 12)],
    ['a keyword as a name', 'locals { null = 1 }', 'Expect the name of a local.', at(1, 10)],
    ['no closing brace', 'locals { a = 1', "Expect '}' after block body.", at(1, 15)],
  ])('refuses %s', (_, input, message, position) => {
    const error = errorOf(input);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(position);
  });
});

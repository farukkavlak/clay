import { ExactNumber, types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { BoundNode, callsIn, CONFIG_FILE, DataBlock, ModuleBlock, namedIn, OutputBlock, ReferenceNode, ResourceBlock, spellNamed, VariableBlock } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';
import { Step } from '../src/reference';
import { steps } from './steps';

function makeParser(input: string, file: string = CONFIG_FILE): Parser {
  return new Parser(new Lexer(input, file).tokenize());
}

const at = (line: number, column: number) => ({ file: CONFIG_FILE, line, column });
const STRING_IN_OPEN = "This '${' is never closed with '}', or a string inside it is not closed on its line";
const LINE_ENDED = String.raw`This string is never closed on its line; write \n for a line break inside it, or use a heredoc`;

/** Returns the error, so a test can check both message and position. */
function errorOf(input: string, file: string = CONFIG_FILE): ConfigError {
  try {
    makeParser(input, file).parse();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${input}`);
}

const attributesOf = (input: string) => (makeParser(input).parse()[0] as ResourceBlock).attributes;
const valueOf = (written: string) => attributesOf(`resource "t" "n" { v = ${written} }`).v;
const typeOf = (written: string) => (makeParser(`variable "v" { type = ${written} }`).parse()[0] as VariableBlock).valueType;
const reference = (parts: (string | number | Step)[], column: number, line = 1) => ({ type: 'Reference', value: steps(...parts), position: at(line, column) });

describe('Clay Parser', () => {
  describe('Valid Cases', () => {
    it('should parse a simple resource block', () => {
      const input = `
      resource "mock_resource" "test" {
        name = "value"
        size = 42
      }
    `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'Resource',
        resourceType: 'mock_resource',
        name: 'test',
        attributes: {
          name: { type: 'String', value: 'value' },
          size: { type: 'Number', value: ExactNumber.parse('42') },
        },
      });
    });

    it('should parse boolean false value', () => {
      const input = `
      resource "mock_resource" "test" {
        enabled = false
      }
    `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect((result[0] as ResourceBlock).attributes.enabled).toMatchObject({ type: 'Boolean', value: false });
    });

    it('should parse null, alone and in a list', () => {
      const result = makeParser('resource "mock_resource" "test" {\n  a = null\n  b = [null, 1]\n}').parse();
      const { attributes } = result[0] as ResourceBlock;

      expect(attributes.a).toEqual({ type: 'Null', position: { file: CONFIG_FILE, line: 2, column: 7 } });
      expect(attributes.b).toMatchObject({ type: 'List', value: [{ type: 'Null' }, { type: 'Number' }] });
    });

    // Only the bare word is null; a name that starts with it is a name.
    it('should read a name that starts with null as a reference', () => {
      const result = makeParser('resource "null_resource" "test" { a = null_thing.b.c }').parse();

      expect((result[0] as ResourceBlock).attributes.a).toMatchObject({ type: 'Reference', value: steps('null_thing', 'b', 'c') });
    });

    it('should parse multiple resources', () => {
      const input = `
      resource "valid" "one" { key = "value" }
      resource "valid" "two" { key = 2 }
    `;
      const parser = makeParser(input);
      const ast = parser.parse();
      expect(ast).toHaveLength(2);
      expect(ast[0].name).toBe('one');
      expect(ast[1].name).toBe('two');
    });

    it('should handle empty attributes', () => {
      const input = `resource "empty" "attributes" {}`;
      const parser = makeParser(input);
      const ast = parser.parse();
      expect((ast[0] as ResourceBlock).attributes).toEqual({});
    });

    it('should ignore comments', () => {
      const input = `
      # This is a comment
      resource "comment" "test" {
        // Another comment
        key = "value" # Inline comment
      }
    `;
      const parser = makeParser(input);
      const ast = parser.parse();
      expect(ast).toHaveLength(1);
      expect((ast[0] as ResourceBlock).attributes.key).toBeDefined();
    });

    it('should ignore comment at EOF without newline', () => {
      const input = `# just a comment`;
      const parser = makeParser(input);
      const ast = parser.parse();
      expect(ast).toHaveLength(0);
    });

    it('should parse variable references', () => {
      const input = `resource "r" "n" { ref = other_resource.field }`;
      const parser = makeParser(input);
      const ast = parser.parse();

      expect((ast[0] as ResourceBlock).attributes.ref).toMatchObject({
        type: 'Reference',
        value: steps('other_resource', 'field'),
      });
    });

    it('should parse deep references', () => {
      const input = `resource "r" "n" { ref = a.b.c.d }`;
      const parser = makeParser(input);
      const ast = parser.parse();

      expect((ast[0] as ResourceBlock).attributes.ref).toMatchObject({
        type: 'Reference',
        value: steps('a', 'b', 'c', 'd'),
      });
    });

    it('should parse a simple variable block', () => {
      const input = `
        variable "environment" {
          default = "dev"
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'Variable',
        name: 'environment',
        attributes: {
          default: { type: 'String', value: 'dev' },
        },
      });
    });

    it('should parse variable with number default', () => {
      const input = 'variable "port" { default = 8080 }';

      const result = makeParser(input).parse();

      expect(result).toHaveLength(1);
      expect((result[0] as VariableBlock).attributes.default).toMatchObject({ type: 'Number', value: ExactNumber.parse('8080') });
    });

    it('should parse variable with boolean default', () => {
      const input = `
        variable "enabled" {
          default = true
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect((result[0] as VariableBlock).attributes.default).toMatchObject({ type: 'Boolean', value: true });
    });

    it('should parse multiple variables and resources', () => {
      const input = `
        variable "env" {
          default = "prod"
        }
        resource "local_file" "config" {
          path = "./config.txt"
        }
        variable "port" {
          default = 3000
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('Variable');
      expect(result[1].type).toBe('Resource');
      expect(result[2].type).toBe('Variable');
    });
  });

  describe('Block kinds are names, not keywords', () => {
    it('takes a dash in a name, and in the reference that reads it', () => {
      const input = 'resource "local_file" "a-b" { content = local_file.a-b.id }';

      const block = makeParser(input).parse()[0] as ResourceBlock;

      expect(block.name).toBe('a-b');
      expect(block.attributes.content).toEqual({ type: 'Reference', value: steps('local_file', 'a-b', 'id'), position: at(1, 41) });
    });

    it('takes a dash in an attribute name and in a map key, as the same identifier rule does', () => {
      const attributes = attributesOf('resource "local_file" "a" { my-attr = { my-key = 1 } }');

      expect(attributes['my-attr']).toEqual({ type: 'Map', value: { 'my-key': { type: 'Number', value: ExactNumber.parse('1'), position: at(1, 50) } }, position: at(1, 39) });
    });

    it('takes a word a reference spells as a name, which an address reads without doubt', () => {
      const block = makeParser('module "module" { source = "./m" }').parse()[0] as ModuleBlock;

      expect(block.name).toBe('module');
    });

    it('takes a block kind as an attribute name', () => {
      const attributes = attributesOf('resource "null_resource" "a" { data = "x" module = 1 variable = true output = "y" resource = "z" }');

      expect(Object.keys(attributes)).toEqual(['data', 'module', 'variable', 'output', 'resource']);
    });

    it('takes a block kind as a map key', () => {
      const attributes = attributesOf('resource "null_resource" "a" { m = { data = "x", output = "y" } }');

      expect(attributes.m).toMatchObject({ type: 'Map', value: { data: { type: 'String', value: 'x' }, output: { type: 'String', value: 'y' } } });
    });

    it('keeps a block kind in a reference', () => {
      const attributes = attributesOf('resource "null_resource" "a" { v = module.m.output }');

      expect(attributes.v).toMatchObject({ type: 'Reference', value: steps('module', 'm', 'output') });
    });

    it('still starts a block with the word, right after an attribute of the same name', () => {
      const program = makeParser('resource "null_resource" "a" { data = 1 }\ndata "local_file" "b" {}').parse();

      expect(program.map((statement) => statement.type)).toEqual(['Resource', 'Data']);
    });

    it('takes only "value", "type" and "sensitive" in an output block, not any name', () => {
      const error = errorOf('output "o" { data = 1 }');

      expect(error.message).toBe('Output "o" takes only "value", "type" and "sensitive", not "data".');
      expect(error.position).toEqual(at(1, 21));
    });

    it('marks an output sensitive, and leaves one that says false as one that says nothing', () => {
      const [marked, unmarked, silent] = makeParser(
        'output "a" {\n  value = 1\n  sensitive = true\n}\noutput "b" {\n  sensitive = false\n  value = 1\n}\noutput "c" { value = 1 }'
      ).parse();

      expect(marked).toMatchObject({ type: 'Output', name: 'a', sensitive: true });
      expect(unmarked).not.toHaveProperty('sensitive');
      expect(silent).not.toHaveProperty('sensitive');
    });

    it.each([
      ['a string', '"true"', at(1, 36)],
      ['a reference', 'var.secret', at(1, 36)],
      ['null', 'null', at(1, 36)],
    ])('refuses %s as sensitive, which is read before any value', (_, written, position) => {
      const error = errorOf(`output "o" { value = 1 sensitive = ${written} }`);

      expect(error.message).toBe('sensitive is true or false.');
      expect(error.position).toEqual(position);
    });

    it('refuses sensitive set twice, and on a variable', () => {
      expect(errorOf('output "o" {\n  value = 1\n  sensitive = true\n  sensitive = true\n}').message).toBe('sensitive is set twice');
      expect(errorOf('variable "v" { sensitive = true }').message).toBe('Variable "v" takes only "default" and "type", not "sensitive".');
    });

    it.each([
      ['an empty output block', 'output "o" {}'],
      ['an output block with only a type', 'output "o" { type = string }'],
    ])('refuses %s, at the block', (_, input) => {
      const error = errorOf(input);

      expect(error.message).toBe('Output "o" has no "value".');
      expect(error.position).toEqual(at(1, 1));
    });

    it.each([
      ['value', 'output "o" { value = 1 value = 2 }', at(1, 24)],
      ['type', 'output "o" { type = string type = number }', at(1, 28)],
    ])('refuses %s set twice in an output block', (name, input, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(`${name} is set twice`);
      expect(error.position).toEqual(position);
    });
  });

  it('writes the place a value was parsed at onto the value itself', () => {
    const attributes = attributesOf('resource "null_resource" "a" { v = "x" }');

    expect(attributes.v).toEqual({ type: 'String', value: 'x', position: at(1, 36) });
  });

  // Comments are skipped, but their lines and columns still count.
  it.each([
    ['a line comment', '# first\nresource "null_resource" "a" { v = "x" }', at(2, 36)],
    ['a comment ending the line before', 'resource "null_resource" "a" { // here\n v = "x" }', at(2, 6)],
  ])('keeps the position right after %s', (_, input, position) => {
    expect(attributesOf(input).v).toMatchObject({ value: 'x', position });
  });

  it('keeps a comment marker inside a string as part of the string', () => {
    expect(attributesOf('resource "null_resource" "a" { v = "a # b // c" }').v).toMatchObject({ value: 'a # b // c' });
  });

  it('puts the end of the file after a trailing comment, as after any other token', () => {
    const input = 'resource "null_resource" "a" { v = "x" # tail';

    expect(errorOf(input).position).toEqual(at(1, input.length + 1));
  });

  describe('Numbers', () => {
    it.each([
      ['-3', '-3'],
      ['1.5', '1.5'],
      ['-0.25', '-0.25'],
      ['1e3', '1000'],
      ['2.5E-3', '0.0025'],
      ['1e+2', '100'],
      ['-0', '0'],
      ['- 5', '-5'],
    ])('reads %s as %s, placed where it starts', (written, value) => {
      expect(attributesOf(`resource "t" "n" { v = ${written} }`).v).toEqual({ type: 'Number', value: ExactNumber.parse(value), position: at(1, 24) });
    });

    it('reads a negative number inside a list and a map', () => {
      const attributes = attributesOf('resource "t" "n" { l = [-1, 2.5] m = { k = -1.5 } }');

      expect(attributes.l).toMatchObject({ type: 'List', value: [{ value: ExactNumber.parse('-1'), position: at(1, 25) }, { value: ExactNumber.parse('2.5') }] });
      expect(attributes.m).toMatchObject({ type: 'Map', value: { k: { value: ExactNumber.parse('-1.5'), position: at(1, 44) } } });
    });

    it('keeps a dash inside a name as part of the name', () => {
      expect(attributesOf('resource "t" "n" { v = a-1 }').v).toMatchObject({ type: 'Reference', value: steps('a-1') });
    });

    it.each([
      ['a point with no digit after it', '1.', '"1." is not a number', at(1, 24)],
      ['an exponent with no digit', '1e', '"1e" is not a number', at(1, 24)],
      ['an exponent sign with no digit', '1e+', '"1e+" is not a number', at(1, 24)],
      ['a point with no digit before it', '.5', 'Unexpected value: .', at(1, 24)],
      ['a minus before a reference', '-var.x', "Expect a number after '-'", at(1, 25)],
      ['two minuses', '--1', "Expect a number after '-'", at(1, 25)],
      ['a minus before a brace', '-', "Expect a number after '-'", at(1, 26)],
      ['a negative number out of range', '-1e5000', '"-1e5000" is out of range', at(1, 24)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });
  });

  describe('Escapes', () => {
    it.each([
      ['a quote', String.raw`"a\"b"`, 'a"b'],
      ['a line break', String.raw`"a\nb"`, 'a\nb'],
      ['a carriage return', String.raw`"a\rb"`, 'a\rb'],
      ['a tab', String.raw`"a\tb"`, 'a\tb'],
      ['a backslash', String.raw`"a\\b"`, String.raw`a\b`],
      // eslint-disable-next-line unicorn/prefer-string-raw -- the test transform reads a valid \u escape inside String.raw as the character itself
      ['a character by four hex digits', '"caf\\u00e9"', 'café'],
      ['a character by eight hex digits', String.raw`"\U0001F600"`, '😀'],
      ['an interpolation written as text', '"$${var.x}"', '${var.x}'],
      ['two dollars before no brace', '"$$x"', '$$x'],
    ])('reads %s', (_, written, value) => {
      expect(valueOf(written)).toEqual({ type: 'String', value, position: at(1, 24) });
    });

    // The backslash escapes itself, so the `${` after it opens an interpolation.
    it('reads an interpolation after an escaped backslash', () => {
      expect(valueOf('"\\\\${var.x}"')).toEqual({ type: 'Template', value: ['\\', reference(['var', 'x'], 29)], position: at(1, 24) });
    });

    it('places a reference by what was written, not by what an escape stands for', () => {
      expect(valueOf('"\\"${var.x}"')).toEqual({ type: 'Template', value: ['"', reference(['var', 'x'], 29)], position: at(1, 24) });
    });

    it('reads a map key with an escape in it as the text it stands for', () => {
      expect(attributesOf(String.raw`resource "t" "n" { m = { "a\"b" = 1 } }`).m).toMatchObject({ type: 'Map', value: { 'a"b': { value: ExactNumber.parse('1') } } });
    });

    it('finds a key set twice when one of the two is spelled with an escape', () => {
      // eslint-disable-next-line unicorn/prefer-string-raw -- the test transform reads a valid \u escape inside String.raw as the character itself
      const error = errorOf('resource "t" "n" { m = { "a" = 1, "\\u0061" = 2 } }');

      expect(error.message).toBe('a is set twice');
      expect(error.position).toEqual(at(1, 35));
    });

    it.each([
      ['a string never closed', 'resource "t" "n" { v = "abc }', LINE_ENDED, at(1, 24)],
      ['a string that ends inside an interpolation', 'resource "t" "n" { v = "a ${var.x', "This '${' is never closed with '}'", at(1, 27)],
      ['a string that ends on a backslash at the end of the file', 'resource "t" "n" { v = "abc\\', LINE_ENDED, at(1, 24)],
      ['a string over two lines', 'resource "t" "n" { v = "a\nb" }', LINE_ENDED, at(1, 24)],
      ['a string over two lines that end in a carriage return', 'resource "t" "n" { v = "a\r\nb" }', LINE_ENDED, at(1, 24)],
      ['a string with a backslash at the end of its line', 'resource "t" "n" { v = "a\\\nb" }', LINE_ENDED, at(1, 24)],
      ['a string whose quote is left out, not the quotes on later lines', 'resource "t" "n" { v = "abc }\nresource "t" "m" { w = "b" }', LINE_ENDED, at(1, 24)],
    ])('refuses %s where it opens', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    // A label becomes part of an address, so it must be a literal.
    it('refuses an interpolation in a block label', () => {
      const error = errorOf('resource "local_file" "a${var.x}" {}');

      expect(error.message).toBe('A label is plain text; it cannot hold an interpolation');
      expect(error.position).toEqual(at(1, 23));
    });

    // Addresses have no escapes, so an escape in a label is refused.
    it('refuses an escape in a block label', () => {
      const error = errorOf(String.raw`resource "local_file" "a\"b" {}`);

      expect(error.message).toContain('Invalid name');
      expect(error.position).toEqual(at(1, 23));
    });

    it.each([
      ['an escape the language does not know', String.raw`"a\qb"`, String.raw`Unknown escape "\q"`, at(1, 26)],
      ['a backslash before a character that does not print', '"a\\\rb"', 'Unknown escape: a backslash before U+000D;', at(1, 26)],
      ['a backslash before a character JavaScript writes in two', String.raw`"a\😀"`, String.raw`Unknown escape "\😀"`, at(1, 26)],
      ['a character with too few hex digits', String.raw`"\u12"`, String.raw`"\u12" is not a character`, at(1, 25)],
      ['a character with a digit that is not hex', String.raw`"\u00zz"`, String.raw`"\u00zz" is not a character`, at(1, 25)],
      ['half of a character JavaScript writes in two', String.raw`"\uD800"`, String.raw`"\uD800" is not a character`, at(1, 25)],
      ['a character past the last one Unicode has', String.raw`"\U00110000"`, String.raw`"\U00110000" is not a character`, at(1, 25)],
      ['an escape after an interpolation', '"${var.x}\\q"', String.raw`Unknown escape "\q"`, at(1, 33)],
      ['an escape in a quoted map key', String.raw`{ "a\q" = 1 }`, String.raw`Unknown escape "\q"`, at(1, 28)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });
  });

  describe('Interpolation', () => {
    it('reads a string with an interpolation as its text and the reference, each where it was written', () => {
      expect(valueOf('"a ${var.x} b"')).toEqual({ type: 'Template', value: ['a ', reference(['var', 'x'], 29), ' b'], position: at(1, 24) });
    });

    it('reads a string that is one interpolation as the reference alone', () => {
      expect(valueOf('"${ var.x }"')).toEqual({ type: 'Template', value: [reference(['var', 'x'], 28)], position: at(1, 24) });
    });

    // Inside `${`, a line break is whitespace.
    it('reads an interpolation over two lines, placing its reference on the line it was written on', () => {
      expect(valueOf('"a ${\n  local_file.f.id}"')).toEqual({ type: 'Template', value: ['a ', reference(['local_file', 'f', 'id'], 3, 2)], position: at(1, 24) });
    });

    it('keeps a string with no interpolation a string', () => {
      expect(valueOf('"$ { } $x"')).toEqual({ type: 'String', value: '$ { } $x', position: at(1, 24) });
    });

    it.each([
      ['one that is never closed', '"a ${var.x"', "This '${' is never closed with '}'", at(1, 27)],
      ['one that is empty', '"${}"', "Expect a reference or a function call inside '${'", at(1, 27)],
      ['one that holds no reference', '"${1}"', "Expect a reference or a function call inside '${'", at(1, 27)],
      ['one with more than a reference', '"${var.x y}"', "Expect '}' after the reference", at(1, 33)],
      ['one whose reference ends on a dot', '"${var.}"', 'Expect property name after dot', at(1, 31)],
      ['one holding a character the lexer knows nothing about', '"${a+b}"', 'Unexpected character: "+"', at(1, 28)],
      ['one holding a comment', '"${var.x # note}"', "A comment cannot sit inside '${'", at(1, 33)],
      ['one holding a comment of the other kind', '"${var.x // note}"', "A comment cannot sit inside '${'", at(1, 33)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });

    it.each([
      ['a key with a dot', '"${var.m["a.b"]}"', 'a.b'],
      ['a key holding the brace that closes an interpolation', '"${var.m["a}b"]}"', 'a}b'],
      ['a key holding what starts a comment', '"${var.m["a#b"]}"', 'a#b'],
      ['a key by what its escapes stand for', '"${var.m["a\\"b"]}"', 'a"b'],
    ])('reads %s inside an interpolation', (_, written, key) => {
      expect(valueOf(written)).toEqual({ type: 'Template', value: [reference(['var', 'm', { key }], 27)], position: at(1, 24) });
    });

    it('reads the text around an interpolation that holds a quoted key', () => {
      expect(valueOf('"x ${var.m["k"]} y"')).toEqual({ type: 'Template', value: ['x ', reference(['var', 'm', { key: 'k' }], 29), ' y'], position: at(1, 24) });
    });

    it.each([
      ['a key that holds an interpolation', '"${var.m["${var.k}"]}"', 'A map key is plain text; it cannot hold an interpolation', at(1, 33)],
      ['a string where a reference should be', '"${"x"}"', "Expect a reference or a function call inside '${'.", at(1, 27)],
    ])('refuses %s inside an interpolation, where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    // A quote where a brace belongs opens a string, so the parser cannot tell which one is at fault.
    it.each([
      ['a quote where its brace belongs, not the quote', 'resource "t" "n" { v = "a ${var.x" }\nresource "t" "m" { w = "b" }', STRING_IN_OPEN, at(1, 27)],
      ['a key over two lines, not the key', 'resource "t" "n" { v = "${var.m["a\nb"]}" }', STRING_IN_OPEN, at(1, 25)],
      ['a key over two lines in a heredoc, not the key', 'resource "t" "n" { v = <<EOT\nx ${var.m["a\nb"]}\nEOT\n}', STRING_IN_OPEN, at(2, 3)],
      ['a key never closed, not the key', 'resource "t" "n" { v = "${var.m["a} }', STRING_IN_OPEN, at(1, 25)],
      ['the first of two still open', 'resource "t" "n" { v = "${var.m["${var.k', "This '${' is never closed with '}'", at(1, 25)],
    ])('names the interpolation for %s', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    // A key is literal, so an interpolation would be text that looks like a reference.
    it('refuses an interpolation in a map key', () => {
      const error = errorOf('resource "t" "n" { m = { "${var.k}" = 1 } }');

      expect(error.message).toBe('A map key is plain text; it cannot hold an interpolation');
      expect(error.position).toEqual(at(1, 26));
    });
  });

  describe('Heredoc', () => {
    const string = (value: string) => ({ type: 'String', value, position: at(1, 24) });

    it.each([
      ['its lines, the last line break with them', '<<EOT\nline 1\nline 2\nEOT\n', 'line 1\nline 2\n'],
      ['an empty one', '<<EOT\nEOT\n', ''],
      ['its text as written: no escapes, no comments, quotes and all', '<<EOT\n\\n "say" # not a comment\nEOT\n', '\\n "say" # not a comment\n'],
      ['$${ as the text ${', '<<EOT\n$${x} $$${y}\nEOT\n', '${x} $${y}\n'],
      ['a closing line with spaces before the name', '<<EOT\n  hi\n  EOT\n', '  hi\n'],
      ['a closing line with a tab before the name and spaces after it', '<<EOT\nhi\n\tEOT \t\n', 'hi\n'],
      ['its name inside the text, where it is not a line of its own', '<<END\nEOT\nx END\nENDING\nEND\n', 'EOT\nx END\nENDING\n'],
      ['lines that end in a carriage return and a line feed as lines that end in a line feed', '<<EOT\r\nhi\r\nEOT\r\n', 'hi\n'],
      ['a carriage return that ends no line as written', '<<EOT\na\rb\nEOT\n', 'a\rb\n'],
      ['with <<-, the lines less the indent they share', '<<-EOT\n    a\n      b\n    EOT\n', 'a\n  b\n'],
      ['with <<-, a blank line as its line break alone, whatever its spaces', '<<-EOT\n    a\n\n  \n      \n    b\n  EOT\n', 'a\n\n\n\nb\n'],
      ['with <<-, blank lines alone as their line breaks', '<<-EOT\n  \n\t\n  EOT\n', '\n\n'],
      ['with <<-, lines that end in a carriage return and a line feed as lines that end in a line feed', '<<-EOT\r\n  a\r\n \r\n  EOT\r\n', 'a\n\n'],
      ['with <<EOT, a blank line as written', '<<EOT\n  \nEOT\n', '  \n'],
      ['with <<-, tabs counted as characters', '<<-EOT\n\t\ta\n\tb\nEOT\n', '\ta\nb\n'],
    ])('reads %s', (_, written, value) => {
      expect(valueOf(written)).toEqual(string(value));
    });

    it('reads an interpolation in it, placed where it is written', () => {
      expect(valueOf('<<EOT\na ${var.x} b\nEOT\n')).toEqual({ type: 'Template', value: ['a ', reference(['var', 'x'], 5, 2), ' b\n'], position: at(1, 24) });
    });

    it('reads its name right after an interpolation as text, since the line did not start there', () => {
      expect(valueOf('<<EOT\n${var.x}EOT\nEOT\n')).toEqual({ type: 'Template', value: [reference(['var', 'x'], 3, 2), 'EOT\n'], position: at(1, 24) });
    });

    it('reads a quoted key in an interpolation in it', () => {
      expect(valueOf('<<EOT\n${var.m["a b"]}\nEOT\n')).toEqual({ type: 'Template', value: [reference(['var', 'm', { key: 'a b' }], 3, 2), '\n'], position: at(1, 24) });
    });

    it('takes the indent off text before an interpolation, with <<-', () => {
      expect(valueOf('<<-EOT\n  ${var.x}\n    b\n  EOT\n')).toEqual({ type: 'Template', value: [reference(['var', 'x'], 5, 2), '\n  b\n'], position: at(1, 24) });
    });

    it('takes no indent off when a line starts with an interpolation, with <<-', () => {
      expect(valueOf('<<-EOT\n${var.x}\n  b\nEOT\n')).toEqual({ type: 'Template', value: [reference(['var', 'x'], 3, 2), '\n  b\n'], position: at(1, 24) });
    });

    // Spreading every indent into one call would overflow the stack on a long heredoc.
    it('reads a long one with <<-', () => {
      const lines = '  a\n'.repeat(200_000);

      expect(valueOf(`<<-EOT\n${lines}  EOT\n`)).toEqual(string('a\n'.repeat(200_000)));
    });

    it('reads one as an item of a list and a value in a map', () => {
      const attributes = attributesOf('resource "t" "n" {\n  l = [<<EOT\na\nEOT\n, "b"]\n  m = { k = <<-EOT\n    c\n    EOT\n  }\n}');

      expect(attributes.l).toMatchObject({
        type: 'List',
        value: [
          { type: 'String', value: 'a\n' },
          { type: 'String', value: 'b' },
        ],
      });
      expect(attributes.m).toMatchObject({ type: 'Map', value: { k: { type: 'String', value: 'c\n' } } });
    });

    it.each([
      ['one never closed', '<<EOT\nhi\n', 'This heredoc is never closed with a line holding only EOT', at(1, 24)],
      ['one whose closing line holds more than its name', '<<EOT\nhi\nEOTX\nEOT x\n', 'This heredoc is never closed with a line holding only EOT', at(1, 24)],
      ['one with no name', '<< EOT\nhi\nEOT\n', 'A heredoc opens with <<NAME or <<-NAME at the end of a line', at(1, 24)],
      ['one with text after its name', '<<EOT x\nhi\nEOT\n', 'A heredoc opens with <<NAME or <<-NAME at the end of a line', at(1, 24)],
      ['one as a map key', '{ <<EOT\nk\nEOT\n = 1 }', 'Expect key in map', at(1, 26)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });

    // The enclosing block must still close, so the error names the brace, not the heredoc.
    it('closes one on the last line of the file, with no line break after it', () => {
      const error = errorOf('resource "t" "n" {\n  v = <<EOT\nhi\nEOT');

      expect(error.message).toBe("Expect '}' after block body.");
      expect(error.position).toEqual(at(4, 4));
    });

    it('refuses one as a block label', () => {
      expect(errorOf('resource "t" <<EOT\nn\nEOT\n {}').message).toContain('Expect resource name string');
    });
  });

  describe('Nested access', () => {
    it.each([
      ['an index', 'var.l[0]', ['var', 'l', 0]],
      ['a quoted key', 'local_file.a.tags["env"]', ['local_file', 'a', 'tags', { key: 'env' }]],
      ['a name after an index', 'var.l[0].name', ['var', 'l', 0, 'name']],
      ['steps of each kind in a row', 'local_file.a.tags["k"][2].x', ['local_file', 'a', 'tags', { key: 'k' }, 2, 'x']],
      ['a key with a dot in it', 'var.m["a.b"]', ['var', 'm', { key: 'a.b' }]],
      ['a key by what its escapes stand for', String.raw`var.m["a\"b"]`, ['var', 'm', { key: 'a"b' }]],
      ['an index written with leading zeros', 'var.l[007]', ['var', 'l', 7]],
    ])('reads %s', (_, written, parts) => {
      expect(valueOf(written)).toEqual(reference(parts, 24));
    });

    it('reads an index inside an interpolation', () => {
      expect(valueOf('"a ${var.l[1]}"')).toEqual({ type: 'Template', value: ['a ', reference(['var', 'l', 1], 29)], position: at(1, 24) });
    });

    it('reads an indexed reference as an item of a list', () => {
      expect(valueOf('[var.l[0], 1]')).toMatchObject({ type: 'List', value: [reference(['var', 'l', 0], 25), { type: 'Number' }] });
    });

    it.each([
      ['a negative index', 'var.l[-1]', 'An index is a whole number from 0 to 9007199254740991, written in digits', at(1, 30)],
      ['a decimal index', 'var.l[1.5]', 'An index is a whole number from 0 to 9007199254740991, written in digits', at(1, 30)],
      ['an index with an exponent', 'var.l[1e2]', 'An index is a whole number from 0 to 9007199254740991, written in digits', at(1, 30)],
      ['an index past what a list can hold', 'var.l[9007199254740992]', 'An index is a whole number from 0 to 9007199254740991, written in digits', at(1, 30)],
      ['a reference as an index', 'var.l[var.i]', "Expect a number or a string inside '['", at(1, 30)],
      ['an empty index', 'var.l[]', "Expect a number or a string inside '['", at(1, 30)],
      ['an index never closed', 'var.l[0 ', "Expect ']' after the index", at(1, 33)],
      ['a key with an interpolation', 'var.m["${var.k}"]', 'A map key is plain text; it cannot hold an interpolation', at(1, 30)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });
  });

  describe('Function calls', () => {
    const call = (name: string, args: unknown[], path: (string | number)[] = [], column = 24) => ({ type: 'Call', name, args, path: steps(...path), position: at(1, column) });

    it('reads a name with parentheses after it as a call, with its argument where it was written', () => {
      expect(valueOf('length(var.x)')).toEqual(call('length', [reference(['var', 'x'], 31)]));
    });

    it('reads a call with no argument', () => {
      expect(valueOf('now()')).toEqual(call('now', []));
    });

    it('reads arguments as a list writes its items, with a comma allowed after the last', () => {
      expect(valueOf('f("a", 1,)')).toMatchObject(
        call('f', [
          { type: 'String', value: 'a', position: at(1, 26) },
          { type: 'Number', position: at(1, 31) },
        ])
      );
    });

    it('reads a call as an argument of another', () => {
      expect(valueOf('f(g(var.x))')).toEqual(call('f', [call('g', [reference(['var', 'x'], 28)], [], 26)]));
    });

    it('reads the steps into what a call gives', () => {
      expect(valueOf('tolist(var.x)[0].name["k"]')).toMatchObject({ type: 'Call', name: 'tolist', path: steps(0, 'name', { key: 'k' }) });
    });

    it('reads a call with a space before its parentheses', () => {
      expect(valueOf('length (var.x)')).toEqual(call('length', [reference(['var', 'x'], 32)]));
    });

    it('keeps a name with no parentheses after it a reference, a function name too', () => {
      expect(valueOf('length.a.id')).toEqual(reference(['length', 'a', 'id'], 24));
    });

    it('reads a call inside an interpolation, with the text around it', () => {
      expect(valueOf('"n ${length(var.x)} m"')).toEqual({ type: 'Template', value: ['n ', call('length', [reference(['var', 'x'], 36)], [], 29), ' m'], position: at(1, 24) });
    });

    it.each([
      ['a map', '"${f({ a = 1 })} x"', { a: { type: 'Number' } }],
      ['a map in a map', '"${f({ a = { b = 1 } })} x"', { a: { type: 'Map', value: { b: { type: 'Number' } } } }],
    ])("reads %s as an argument inside an interpolation, whose closing brace is not the interpolation's", (_, written, map) => {
      expect(valueOf(written)).toMatchObject({ type: 'Template', value: [{ type: 'Call', args: [{ type: 'Map', value: map }] }, ' x'] });
    });

    it('refuses a call never closed at the end of the file where the file ends', () => {
      const error = errorOf('resource "t" "n" { v = length("a"');

      expect(error.message).toBe("Expect ')' after the arguments.");
      expect(error.position).toEqual(at(1, 34));
    });

    it('names a map never closed inside an interpolation by the interpolation', () => {
      const error = errorOf('resource "t" "n" { v = "${f({ a = 1 )}" }');

      expect(error.message).toBe("This '${' is never closed with '}', or a string inside it is not closed on its line");
      expect(error.position).toEqual(at(1, 25));
    });

    it.each([
      ['a call never closed', 'length(var.x', "Expect ')' after the arguments.", at(1, 37)],
      ['arguments with no comma between', 'length(var.x var.y)', "Expect ')' after the arguments.", at(1, 37)],
      ['a comma with no argument before it', 'length(,)', 'Unexpected value: ,', at(1, 31)],
      ['a closing parenthesis on its own', ')', 'Unexpected value: )', at(1, 24)],
      ['more than a call inside an interpolation', '"${length(var.x) y}"', "Expect '}' after the function call.", at(1, 41)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    it('finds every call in a value, the outer one before those in its arguments', () => {
      expect(callsIn(valueOf('[f(1), { a = "x ${g(h(2))}" }, var.x]')).map((found) => found.name)).toEqual(['f', 'g', 'h']);
    });

    it.each([
      ['a call without its arguments, with its steps', 'f(1, 2)[0].a', 'f(...)[0].a'],
      ['a reference as it is written', 'var.m["a.b"][0]', 'var.m["a.b"][0]'],
    ])('spells %s', (_, written, spelled) => {
      expect(spellNamed(valueOf(written) as ReferenceNode)).toBe(spelled);
    });
  });

  describe('For expressions', () => {
    const bound = (parts: (string | number | Step)[], column: number, line = 1) => ({ type: 'Bound', value: steps(...parts), position: at(line, column) });

    it('reads a for over a collection, with the name it gives each item read in its body', () => {
      expect(valueOf('[for n in var.names : n]')).toEqual({
        type: 'For',
        valueName: 'n',
        collection: reference(['var', 'names'], 34),
        body: bound(['n'], 46),
        position: at(1, 24),
      });
    });

    it('reads a key name before the value name, both read in the body', () => {
      expect(valueOf('[for i, n in var.names : "${i}-${n}"]')).toMatchObject({
        type: 'For',
        keyName: 'i',
        valueName: 'n',
        body: { type: 'Template', value: [bound(['i'], 52), '-', bound(['n'], 57)] },
      });
    });

    it('reads the steps written after a name the for gives', () => {
      expect(valueOf('[for f in var.files : f.paths["a.b"][0]]')).toMatchObject({ body: bound(['f', 'paths', { key: 'a.b' }, 0], 46) });
    });

    it('reads a name it does not give in its body as a reference', () => {
      expect(valueOf('[for n in var.names : local_file.a.id]')).toMatchObject({ body: reference(['local_file', 'a', 'id'], 46) });
    });

    it('reads its own name in its collection as a reference, since it names the items only in the body', () => {
      expect(valueOf('[for n in n.a.id : n]')).toMatchObject({ collection: reference(['n', 'a', 'id'], 34) });
    });

    it('reads a name it gives as a reference again after the for', () => {
      expect(valueOf('[[for n in var.x : n], n.a.id]')).toMatchObject({ value: [{ type: 'For' }, reference(['n', 'a', 'id'], 47)] });
    });

    it('reads the names of a for around it in the body of one inside it', () => {
      expect(valueOf('[for a in var.l : [for b in a : "${a}${b}"]]')).toMatchObject({
        body: {
          type: 'For',
          collection: bound(['a'], 52),
          body: { type: 'Template', value: [bound(['a'], 59), bound(['b'], 63)] },
        },
      });
    });

    it('reads a call in the body, with a name the for gives as its argument', () => {
      expect(valueOf('[for n in var.l : length(n)]')).toMatchObject({ body: { type: 'Call', name: 'length', args: [bound(['n'], 49)] } });
    });

    it('reads a for written over several lines', () => {
      expect(valueOf('[\n  for n in var.names :\n  n\n]')).toMatchObject({ type: 'For', body: bound(['n'], 3, 3) });
    });

    it('keeps a list whose first item is a reference into a resource named for a list', () => {
      expect(valueOf('[for.a.id]')).toEqual({ type: 'List', value: [reference(['for', 'a', 'id'], 25)], position: at(1, 24) });
    });

    it('finds the references and calls in its collection and its body, and not the names it gives', () => {
      const found = namedIn(valueOf('[for n in var.x : "${n}${length(var.y)}"]'));

      expect(found.map((node) => spellNamed(node))).toEqual(['var.x', 'length(...)', 'var.y']);
    });

    it('spells a name the for gives as it is written', () => {
      expect(spellNamed(bound(['f', 'paths', { key: 'a.b' }, 0], 1) as BoundNode)).toBe('f.paths["a.b"][0]');
    });

    it('takes a for over a constant as a variable default', () => {
      const [variable] = makeParser('variable "v" { default = [for n in ["a"] : n] }').parse() as VariableBlock[];

      expect(variable.attributes.default).toMatchObject({ type: 'For', collection: { type: 'List' } });
    });

    it('refuses a for over a variable as a variable default, where the variable is read', () => {
      const error = errorOf('variable "v" { default = [for n in var.x : n] }');

      expect(error.message).toBe("A variable's default is a constant, so it cannot hold var.x");
      expect(error.position).toEqual(at(1, 36));
    });

    it.each([
      ['a for with no name', '[for 1 in var.x : 1]', "Expect a name after 'for'.", at(1, 29)],
      ['a for with no value name after its comma', '[for i, 1 in var.x : i]', "Expect a name after ','.", at(1, 32)],
      ['a for with no in', '[for n of var.x : n]', "Expect 'in' after the names in a for expression.", at(1, 31)],
      ['a for with no colon', '[for n in var.x n]', "Expect ':' after the collection in a for expression.", at(1, 40)],
      ['a for with more than its body', '[for n in var.x : n n]', "Expect ']' after the for expression.", at(1, 44)],
      ['a for that filters with if', '[for n in var.x : n if n]', "Expect ']' after the for expression.", at(1, 44)],
      ['a for never closed', '[for n in var.x : n', "Expect ']' after the for expression.", at(1, 44)],
      ['a key and a value of one name', '[for i, i in var.x : i]', 'The key and the value of a for need names of their own', at(1, 32)],
      ['a name a for around it gives', '[for n in var.x : [for n in n : n]]', '"n" is named by a for around this one already', at(1, 47)],
      ['a colon outside a for', ':', 'Unexpected value: :', at(1, 24)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    it.each(['var', 'local', 'data', 'module', 'count', 'each', 'path'])('refuses "%s" as a name a for gives, which a reference reads as something else', (word) => {
      const error = errorOf(`resource "t" "n" { v = [for ${word} in ["a"] : ${word}] }`);

      expect(error.message).toBe(`"${word}" cannot name an item in a for: a reference reads "${word}." as something else`);
      expect(error.position).toEqual(at(1, 29));
    });

    it.each([
      ['declared before the for', 'resource "local_file" "a" {}\noutput "o" { value = [for local_file in ["a"] : local_file] }', at(2, 27)],
      ['declared after the for', 'output "o" { value = [for i, local_file in ["a"] : i] }\nresource "local_file" "a" {}', at(1, 30)],
    ])('refuses the type of a resource %s as a name a for gives', (_, input, position) => {
      const error = errorOf(input);

      expect(error.message).toBe('"local_file" cannot name an item in a for: a reference reads "local_file." as a resource of that type');
      expect(error.position).toEqual(position);
    });
  });

  describe('For expressions that make an object', () => {
    const bound = (parts: (string | number | Step)[], column: number) => ({ type: 'Bound', value: steps(...parts), position: at(1, column) });

    it('reads a key and a value for each item, both with the names the for gives', () => {
      expect(valueOf('{for k, v in var.m : k => v}')).toEqual({
        type: 'For',
        keyName: 'k',
        valueName: 'v',
        collection: reference(['var', 'm'], 37),
        key: bound(['k'], 45),
        body: bound(['v'], 50),
        position: at(1, 24),
      });
    });

    it('groups the values of one key when the value has ... after it', () => {
      expect(valueOf('{for n in var.l : n => n...}')).toMatchObject({ key: bound(['n'], 42), body: bound(['n'], 47), grouped: true });
    });

    it('reads a number right before ... as the number', () => {
      expect(valueOf('{for n in var.l : n => 1...}')).toMatchObject({ body: { type: 'Number', value: ExactNumber.parse('1') }, grouped: true });
    });

    it('does not group without ...', () => {
      expect(valueOf('{for n in var.l : n => n}')).not.toHaveProperty('grouped');
    });

    it('keeps a map with a key named for', () => {
      expect(valueOf('{ for = 1 }')).toEqual({ type: 'Map', value: { for: { type: 'Number', value: ExactNumber.parse('1'), position: at(1, 32) } }, position: at(1, 24) });
    });

    it('finds the references in its key', () => {
      const found = namedIn(valueOf('{for n in var.x : var.k => n}'));

      expect(found.map((node) => spellNamed(node))).toEqual(['var.x', 'var.k']);
    });

    it.each([
      ['a for with no =>', '{for n in var.x : n n}', "Expect '=>' after the key in a for expression.", at(1, 44)],
      ['a for closed with ]', '{for n in var.x : n => n]', "Expect '}' after the for expression.", at(1, 48)],
      ['a => in a for that makes a list', '[for n in var.x : n => n]', "Expect ']' after the for expression.", at(1, 44)],
      ['... in a for that makes a list', '[for n in var.x : n...]', "Expect ']' after the for expression.", at(1, 43)],
      ['... outside a for', '...', 'Unexpected value: ...', at(1, 24)],
    ])('refuses %s where it is written', (_, written, message, position) => {
      const error = errorOf(`resource "t" "n" { v = ${written} }`);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });
  });

  describe('Error Cases', () => {
    it('refuses a second block with the same name, at its position', () => {
      const twice = {
        'resource "null_resource" "a"': 'resource "null_resource" "a" {}\nresource "null_resource" "a" {}',
        'data "local_file" "a"': 'data "local_file" "a" {}\ndata "local_file" "a" {}',
        'variable "v"': 'variable "v" {}\nvariable "v" {}',
        'output "o"': 'output "o" { value = "1" }\noutput "o" { value = "2" }',
        'module "m"': 'module "m" { source = "./m" }\nmodule "m" { source = "./m" }',
      };

      for (const [label, input] of Object.entries(twice)) {
        const error = errorOf(input);

        expect(error.message).toBe(`${label} is declared twice`);
        expect(error.position).toEqual(at(2, 1));
      }
    });

    // The second would silently replace the first.
    it.each([
      ['an attribute', 'resource "null_resource" "a" { v = 1 v = 2 }', 'v is set twice', at(1, 38)],
      ['a map key', 'resource "null_resource" "a" { m = { k = 1, k = 2 } }', 'k is set twice', at(1, 45)],
    ])('refuses %s given twice, at the second one', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    // A plain object treats `__proto__` as its prototype, so the value would silently vanish.
    it.each([
      ['an attribute', 'resource "null_resource" "a" { __proto__ = 1 }', at(1, 32)],
      ['a map key', 'resource "null_resource" "a" { m = { __proto__ = 1 } }', at(1, 38)],
      ['a quoted map key', 'resource "null_resource" "a" { m = { "__proto__" = 1 } }', at(1, 38)],
    ])('refuses __proto__ as %s name', (_, input, position) => {
      const error = errorOf(input);

      expect(error.message).toBe('__proto__ cannot be a name');
      expect(error.position).toEqual(position);
    });

    // Names end up in addresses, which split on dots.
    it.each([
      ['a resource name', 'resource "local_file" "a.b" {}', 'Invalid name "a.b"', at(1, 23)],
      ['a resource type', 'resource "local.file" "a" {}', 'Invalid type "local.file"', at(1, 10)],
      ['a data source name', 'data "local_file" "a.b" {}', 'Invalid name "a.b"', at(1, 19)],
      ['a variable name', 'variable "a.b" {}', 'Invalid name "a.b"', at(1, 10)],
      ['an output name', 'output "a.b" { value = "1" }', 'Invalid name "a.b"', at(1, 8)],
      ['a module name', 'module "a.b" { source = "./m" }', 'Invalid name "a.b"', at(1, 8)],
      ['an empty name', 'resource "local_file" "" {}', 'Invalid name ""', at(1, 23)],
      ['a name that starts with a digit', 'resource "local_file" "1a" {}', 'Invalid name "1a"', at(1, 23)],
      ['a name a reference would read as a boolean', 'resource "local_file" "true" {}', 'Invalid name "true"', at(1, 23)],
      ['a name a reference would read as null', 'resource "local_file" "null" {}', 'Invalid name "null"', at(1, 23)],
    ])('refuses %s that is no identifier', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });

    // These words are reference prefixes, never resource types.
    it.each([
      ['module', 'resource "module" "a" {}', at(1, 10)],
      ['var', 'resource "var" "a" {}', at(1, 10)],
      ['local', 'resource "local" "a" {}', at(1, 10)],
      ['data', 'data "data" "a" {}', at(1, 6)],
      ['count', 'resource "count" "a" {}', at(1, 10)],
      ['each', 'resource "each" "a" {}', at(1, 10)],
      ['path', 'resource "path" "a" {}', at(1, 10)],
    ])('refuses "%s" as a type, which a reference reads as something else', (word, input, position) => {
      const error = errorOf(input);

      expect(error.message).toContain(`"${word}" cannot be a type`);
      expect(error.position).toEqual(position);
    });

    it.each([
      ['a misspelled default', 'variable "v" { defualt = "a" }', 'defualt', at(1, 26)],
      ['a description it does not keep', 'variable "v" { default = "a" description = "why" }', 'description', at(1, 44)],
    ])('refuses %s in a variable block, at its value', (_, input, attribute, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(`Variable "v" takes only "default" and "type", not "${attribute}".`);
      expect(error.position).toEqual(position);
    });

    it.each([
      ['default', 'variable "v" { default = "a" default = "b" }', at(1, 30)],
      ['type', 'variable "v" { type = string type = number }', at(1, 30)],
    ])('refuses %s set twice in a variable block', (name, input, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(`${name} is set twice`);
      expect(error.position).toEqual(position);
    });

    it.each([
      ['a reference', 'variable "v" { default = var.p }', 'var.p', at(1, 26)],
      ['a call', 'variable "v" { default = length("ab") }', 'length(...)', at(1, 26)],
      ['a reference in a string', 'variable "v" { default = "x-${var.p}" }', 'var.p', at(1, 31)],
      ['a call in a heredoc', 'variable "v" {\n  default = <<EOT\n${length("ab")}\nEOT\n}', 'length(...)', at(3, 3)],
      ['a reference in a list', 'variable "v" { default = ["a", var.p] }', 'var.p', at(1, 32)],
      ['a call before the reference it is given', 'variable "v" { default = length(var.p) }', 'length(...)', at(1, 26)],
      ['a reference deep in a map', 'variable "v" { default = { a = { b = var.p } } }', 'var.p', at(1, 38)],
    ])('refuses %s in a variable default, where it is written', (_, input, named, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(`A variable's default is a constant, so it cannot hold ${named}`);
      expect(error.position).toEqual(position);
    });

    it('takes a default of literals at any depth', () => {
      const [variable] = makeParser('variable "v" { default = { a = ["x", 1, true, null] } }').parse();

      expect(variable).toMatchObject({ attributes: { default: { type: 'Map', value: { a: { type: 'List' } } } } });
    });

    it('refuses a variable named "source", which a module call reads as its path', () => {
      const error = errorOf('variable "source" { default = "x" }');

      expect(error.message).toBe('"source" cannot be a variable name: a module call reads it as the module\'s path.');
      expect(error.position).toEqual(at(1, 10));
    });

    it.each(['count', 'for_each'])('refuses a variable named "%s", which a module call keeps for itself', (name) => {
      const error = errorOf(`variable "${name}" { default = 2 }`);

      expect(error.message).toBe(`"${name}" cannot be a variable name: a module call keeps it for itself.`);
      expect(error.position).toEqual(at(1, 10));
    });

    it('refuses a number out of range where it is written, without writing all of it out again', () => {
      const error = errorOf(`output "o" { value = ${'1'.repeat(1001)} }`);

      expect(error.message).toBe('"11111111111111111111…" (1001 characters) is out of range: a number reaches at most 1000 places either side of the point');
      expect(error.position).toEqual(at(1, 22));
    });

    it('tells blocks of different kinds with one name apart', () => {
      const input = 'variable "x" {}\noutput "x" { value = "1" }\nmodule "x" { source = "./x" }\nresource "null_resource" "x" {}\nresource "local_file" "x" {}';

      expect(makeParser(input).parse()).toHaveLength(5);
    });

    // Each error points at the token the parser stopped on, not the block.
    it.each([
      ['a resource with only one label', 'resource "name" { key = "val" }', 'Expect resource name string', at(1, 17)],
      ['a resource with no name', 'resource "type" { key = "val" }', 'Expect resource name string', at(1, 17)],
      ['a block body that never opens', 'resource "type" "name" key = "val"', "Expect '{'", at(1, 24)],
      ['a block body that never closes', 'resource "type" "name" { key = "val"', "Expect '}'", at(1, 37)],
      ['an attribute with no "="', 'resource "type" "name" { key "val" }', "Expect '='", at(1, 30)],
      ['an attribute named by a string', 'resource "type" "name" { "key" = "val" }', 'Expect attribute name', at(1, 26)],
      ['a value that is not one', 'resource "type" "name" { key = = }', 'Unexpected value: =', at(1, 32)],
      ['a word that starts no block', 'random_token "type" "name" {}', 'Unexpected token: random_token', at(1, 1)],
      ['a reference that ends on a dot', 'resource "type" "name" { ref = foo. }', 'Expect property name after dot', at(1, 37)],
      ['a character the lexer knows nothing about', '@', 'Unexpected character: "@"', at(1, 1)],
    ])('says what is wrong with %s and where', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });

    it('refuses a top-level word that is not a block kind, even one an object has by birth', () => {
      for (const word of ['bogus', 'constructor', 'toString', '__proto__']) expect(errorOf(`${word} "x" {}`).message).toBe(`Unexpected token: ${word}`);
    });

    it('names the file the error was written in', () => {
      const error = errorOf('resource "type" "name" { key = = }', 'modules/app/main.clay');

      expect(error.position.file).toBe('modules/app/main.clay');
    });
  });

  describe('Count', () => {
    it('keeps count apart from the attributes a provider is sent', () => {
      const [block] = makeParser('resource "local_file" "a" { count = 2 path = "a" }').parse() as ResourceBlock[];

      expect(block.count).toEqual({ type: 'Number', value: ExactNumber.parse('2'), position: at(1, 37) });
      expect(block.attributes).toEqual({ path: { type: 'String', value: 'a', position: at(1, 46) } });
    });

    it('leaves count out of a resource that has none', () => {
      const [block] = makeParser('resource "local_file" "a" { path = "a" }').parse() as ResourceBlock[];

      expect(block).not.toHaveProperty('count');
    });

    it('keeps count on a module apart from its inputs', () => {
      const [block] = makeParser('module "m" { source = "./m" count = 2 }').parse() as ModuleBlock[];

      expect(block.count).toEqual({ type: 'Number', value: ExactNumber.parse('2'), position: at(1, 37) });
      expect(block.attributes).toEqual({ source: { type: 'String', value: './m', position: at(1, 23) } });
    });

    it('reads count.index as a reference', () => {
      expect(valueOf('"${count.index}"')).toEqual({ type: 'Template', value: [reference(['count', 'index'], 27)], position: at(1, 24) });
    });

    it('keeps count on a data source apart from what its provider is sent', () => {
      const [block] = makeParser('data "local_file" "a" { count = 2 path = "a" }').parse() as DataBlock[];

      expect(block.count).toEqual({ type: 'Number', value: ExactNumber.parse('2'), position: at(1, 33) });
      expect(block.attributes).toEqual({ path: { type: 'String', value: 'a', position: at(1, 42) } });
    });
  });

  describe('For each', () => {
    it('keeps for_each apart from the attributes a provider is sent', () => {
      const [block] = makeParser('resource "local_file" "a" { for_each = ["x"] path = "a" }').parse() as ResourceBlock[];

      expect(block.forEach).toEqual({ type: 'List', value: [{ type: 'String', value: 'x', position: at(1, 41) }], position: at(1, 40) });
      expect(block.attributes).toEqual({ path: { type: 'String', value: 'a', position: at(1, 53) } });
    });

    it('leaves for_each out of a resource that has none', () => {
      const [block] = makeParser('resource "local_file" "a" { path = "a" }').parse() as ResourceBlock[];

      expect(block).not.toHaveProperty('forEach');
    });

    it('reads each.key and each.value as references', () => {
      expect(valueOf('"${each.key}-${each.value}"')).toEqual({
        type: 'Template',
        value: [reference(['each', 'key'], 27), '-', reference(['each', 'value'], 39)],
        position: at(1, 24),
      });
    });

    it('refuses a resource with both count and for_each, at for_each', () => {
      const error = errorOf('resource "local_file" "a" { count = 2 for_each = ["x"] }');

      expect(error.message).toBe('resource "local_file" "a" has count or for_each, not both');
      expect(error.position).toEqual(at(1, 50));
    });

    it('keeps for_each on a data source apart from what its provider is sent', () => {
      const [block] = makeParser('data "local_file" "a" { for_each = ["x"] path = "a" }').parse() as DataBlock[];

      expect(block.forEach).toEqual({ type: 'List', value: [{ type: 'String', value: 'x', position: at(1, 37) }], position: at(1, 36) });
      expect(block.attributes).toEqual({ path: { type: 'String', value: 'a', position: at(1, 49) } });
    });

    it('refuses a data source with both count and for_each, at for_each', () => {
      const error = errorOf('data "local_file" "a" { count = 2 for_each = ["x"] }');

      expect(error.message).toBe('data "local_file" "a" has count or for_each, not both');
      expect(error.position).toEqual(at(1, 46));
    });

    it('keeps for_each on a module apart from its inputs', () => {
      const [block] = makeParser('module "m" { source = "./m" for_each = ["x"] }').parse() as ModuleBlock[];

      expect(block.forEach).toEqual({ type: 'List', value: [{ type: 'String', value: 'x', position: at(1, 41) }], position: at(1, 40) });
      expect(block.attributes).toEqual({ source: { type: 'String', value: './m', position: at(1, 23) } });
    });

    it('refuses a module with both count and for_each, at for_each', () => {
      const error = errorOf('module "m" { source = "./m" count = 2 for_each = ["x"] }');

      expect(error.message).toBe('module "m" has count or for_each, not both');
      expect(error.position).toEqual(at(1, 50));
    });
  });

  describe('Variable types', () => {
    it.each([
      ['string', types.string],
      ['number', types.number],
      ['bool', types.bool],
      ['any', types.dynamic],
      ['list(string)', types.list(types.string)],
      ['set(number)', types.set(types.number)],
      ['map(bool)', types.map(types.bool)],
      ['list(set(any))', types.list(types.set(types.dynamic))],
      ['tuple([string, number,])', types.tuple([types.string, types.number])],
      ['tuple([])', types.tuple([])],
      ['object({ a = string, b = list(number) })', types.object({ a: types.string, b: types.list(types.number) })],
      ['object({\n a = string\n b = bool\n})', types.object({ a: types.string, b: types.bool })],
      ['object({ a = string, b = optional(number) })', types.object({ a: types.string, b: types.number }, ['b'])],
      ['object({ a = optional(string, "x") })', types.object({ a: types.string }, ['a'])],
      ['list(object({ a = optional(object({ b = optional(bool) })) }))', types.list(types.object({ a: types.object({ b: types.bool }, ['b']) }, ['a']))],
    ])('reads %s', (written, type) => {
      expect(typeOf(written)).toEqual(type);
    });

    it('keeps the type beside the default', () => {
      const [variable] = makeParser('variable "v" {\n  type    = set(string)\n  default = ["a"]\n}').parse() as VariableBlock[];

      expect(variable.valueType).toEqual(types.set(types.string));
      expect(variable.attributes).toEqual({ default: { type: 'List', value: [{ type: 'String', value: 'a', position: at(3, 14) }], position: at(3, 13) } });
    });

    it('keeps the defaults an object type gives, laid out as the type is', () => {
      const [variable] = makeParser(
        'variable "v" {\n  type = list(object({ a = optional(object({ b = optional(bool, true) }), {}), c = optional(tuple([string, object({ d = optional(number, 1) })])) }))\n}'
      ).parse() as VariableBlock[];

      expect(variable.defaults).toEqual({
        element: {
          values: { a: { type: 'Map', value: {}, position: at(2, 75) } },
          within: {
            a: { values: { b: { type: 'Boolean', value: true, position: at(2, 65) } } },
            c: { within: { 1: { values: { d: { type: 'Number', value: ExactNumber.parse('1'), position: at(2, 138) } } } } },
          },
        },
      });
    });

    it('keeps no defaults where an optional attribute names none', () => {
      const [variable] = makeParser('variable "v" { type = object({ a = optional(string) }) }').parse() as VariableBlock[];

      expect(Object.hasOwn(variable, 'defaults')).toBe(false);
    });

    it('leaves the type out of a variable that names none', () => {
      const [variable] = makeParser('variable "v" { default = 1 }').parse() as VariableBlock[];

      expect(Object.hasOwn(variable, 'valueType')).toBe(false);
    });

    it.each([
      ['a quoted type', '"string"', 'A type is written without quotes: string, not "string"', at(1, 23)],
      ['a misspelled type', 'list(strin)', '"strin" is not a type', at(1, 28)],
      ['a type that holds none given one', 'string(number)', "string holds no other type, so it takes no '('", at(1, 29)],
      ['a collection without its element', 'list', "Expect '(' after list.", at(2, 1)],
      ['an unclosed collection', 'map(string', "Expect ')' after the type map holds.", at(2, 1)],
      ['a tuple without brackets', 'tuple(string)', "Expect '[' after 'tuple('.", at(1, 29)],
      ['tuple types without a comma between', 'tuple([string number])', "Expect ']' after the types in a tuple.", at(1, 37)],
      ['an object without braces', 'object(string)', "Expect '{' after 'object('.", at(1, 30)],
      ['an object attribute named twice', 'object({ a = string, a = number })', 'a is set twice', at(1, 44)],
      ['an object attribute named __proto__', 'object({ __proto__ = string })', '__proto__ cannot be a name', at(1, 32)],
      ['a value where a type goes', '1', 'Expect a type: string, number, bool, any', at(1, 23)],
      ["optional as a variable's type", 'optional(string)', "optional(...) is written only as the type of an object's attribute", at(1, 23)],
      ['optional as what a list holds', 'list(optional(string))', "optional(...) is written only as the type of an object's attribute", at(1, 28)],
      ['optional without its type', 'object({ a = optional })', "Expect '(' after optional.", at(1, 45)],
      ['optional given three arguments', 'object({ a = optional(number, 1, 2) })', "Expect ')' after the type of optional, or its default.", at(1, 54)],
      [
        "a reference in an optional attribute's default",
        'object({ a = optional(number, var.z) })',
        "An optional attribute's default is a constant, so it cannot hold var.z",
        at(1, 53),
      ],
      [
        "a call in an optional attribute's default",
        'object({ a = optional(number, length("ab")) })',
        "An optional attribute's default is a constant, so it cannot hold length(...)",
        at(1, 53),
      ],
    ])('refuses %s, where it is written', (_, written, message, position) => {
      const error = errorOf(`variable "v" { type = ${written}\n}`);

      expect(error.message).toContain(message);
      expect(error.position).toEqual(position);
    });
  });

  describe('Output Blocks', () => {
    it('should parse output block with string value', () => {
      const input = `
        output "my_output" {
          value = "test_value"
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'Output',
        name: 'my_output',
        value: { type: 'String', value: 'test_value' },
      });
    });

    it('should parse output block with number value', () => {
      const input = `output "count" { value = 42 }`;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result[0]).toMatchObject({
        type: 'Output',
        name: 'count',
        value: { type: 'Number', value: ExactNumber.parse('42') },
      });
    });

    it('should parse output block with reference value', () => {
      const input = `output "ref_output" { value = my_resource.name.attr }`;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result[0]).toMatchObject({
        type: 'Output',
        name: 'ref_output',
        value: { type: 'Reference', value: steps('my_resource', 'name', 'attr') },
      });
    });

    it('keeps the type an output names, written before or after its value', () => {
      const [output] = makeParser('output "o" {\n  type  = list(string)\n  value = ["a"]\n}').parse() as OutputBlock[];

      expect(output.valueType).toEqual(types.list(types.string));
      expect(output.value).toEqual({ type: 'List', value: [{ type: 'String', value: 'a', position: at(3, 12) }], position: at(3, 11) });
    });

    it("keeps the defaults an output's type gives", () => {
      const [output] = makeParser('output "o" {\n  value = {}\n  type  = object({ a = optional(number, 1) })\n}').parse() as OutputBlock[];

      expect(output.valueType).toEqual(types.object({ a: types.number }, ['a']));
      expect(output.defaults).toEqual({ values: { a: { type: 'Number', value: ExactNumber.parse('1'), position: at(3, 41) } } });
    });

    it('leaves the type and defaults out of an output that names none', () => {
      const [output] = makeParser('output "o" { value = 1 }').parse() as OutputBlock[];

      expect(Object.hasOwn(output, 'valueType')).toBe(false);
      expect(Object.hasOwn(output, 'defaults')).toBe(false);
    });

    it("refuses a reference in an optional attribute's default of an output's type", () => {
      const error = errorOf('output "o" {\n  value = {}\n  type  = object({ a = optional(number, var.z) })\n}');

      expect(error.message).toBe("An optional attribute's default is a constant, so it cannot hold var.z");
      expect(error.position).toEqual(at(3, 41));
    });
  });
});

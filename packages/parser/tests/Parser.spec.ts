import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ResourceBlock, VariableBlock } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

function makeParser(input: string, file: string = CONFIG_FILE): Parser {
  return new Parser(new Lexer(input, file).tokenize());
}

const at = (line: number, column: number) => ({ file: CONFIG_FILE, line, column });

/** The error a bad configuration throws, so a test can pin both what it says and where it points. */
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

describe('Clay Parser', () => {
  describe('Valid Cases', () => {
    it('should parse a simple resource block', () => {
      const input = `
      resource "mock_resource" "test" {
        name = "value"
        count = 42
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
          count: { type: 'Number', value: 42 },
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
        value: ['other_resource', 'field'],
      });
    });

    it('should parse deep references', () => {
      const input = `resource "r" "n" { ref = a.b.c.d }`;
      const parser = makeParser(input);
      const ast = parser.parse();

      expect((ast[0] as ResourceBlock).attributes.ref).toMatchObject({
        type: 'Reference',
        value: ['a', 'b', 'c', 'd'],
      });
    });

    it('should parse a simple variable block', () => {
      const input = `
        variable "environment" {
          type = "string"
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
          type: { type: 'String', value: 'string' },
          default: { type: 'String', value: 'dev' },
        },
      });
    });

    it('should parse variable with number default', () => {
      const input = `
        variable "port" {
          type = "number"
          default = 8080
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result).toHaveLength(1);
      expect((result[0] as VariableBlock).attributes.default).toMatchObject({ type: 'Number', value: 8080 });
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

    it('should parse variable with description', () => {
      const input = `
        variable "region" {
          type = "string"
          default = "us-east-1"
          description = "AWS region"
        }
      `;
      const parser = makeParser(input);
      const result = parser.parse();

      expect((result[0] as VariableBlock).attributes.description).toMatchObject({ type: 'String', value: 'AWS region' });
    });
  });

  describe('Block kinds are names, not keywords', () => {
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

      expect(attributes.v).toMatchObject({ type: 'Reference', value: ['module', 'm', 'output'] });
    });

    it('still starts a block with the word, right after an attribute of the same name', () => {
      const program = makeParser('resource "null_resource" "a" { data = 1 }\ndata "local_file" "b" {}').parse();

      expect(program.map((statement) => statement.type)).toEqual(['Resource', 'Data']);
    });

    it('takes only "value" in an output block, not any name', () => {
      const error = errorOf('output "o" { data = 1 }');

      expect(error.message).toBe("Expect 'value' in output block.");
      expect(error.position).toEqual(at(1, 14));
    });
  });

  it('writes the place a value was parsed at onto the value itself', () => {
    const attributes = attributesOf('resource "null_resource" "a" { v = "x" }');

    expect(attributes.v).toEqual({ type: 'String', value: 'x', position: at(1, 36) });
  });

  // Comments are skipped, but the lines and columns they take up still count.
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

    // The second would replace the first in silence, the way a second block once did.
    it.each([
      ['an attribute', 'resource "null_resource" "a" { v = 1 v = 2 }', 'v is set twice', at(1, 38)],
      ['a map key', 'resource "null_resource" "a" { m = { k = 1, k = 2 } }', 'k is set twice', at(1, 45)],
    ])('refuses %s given twice, at the second one', (_, input, message, position) => {
      const error = errorOf(input);

      expect(error.message).toBe(message);
      expect(error.position).toEqual(position);
    });

    it('tells blocks of different kinds with one name apart', () => {
      const input = 'variable "x" {}\noutput "x" { value = "1" }\nmodule "x" { source = "./x" }\nresource "null_resource" "x" {}\nresource "local_file" "x" {}';

      expect(makeParser(input).parse()).toHaveLength(5);
    });

    // Each case points at the token the parser stopped on, not at the block it was reading.
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
        value: { type: 'Number', value: 42 },
      });
    });

    it('should parse output block with reference value', () => {
      const input = `output "ref_output" { value = my_resource.name.attr }`;
      const parser = makeParser(input);
      const result = parser.parse();

      expect(result[0]).toMatchObject({
        type: 'Output',
        name: 'ref_output',
        value: { type: 'Reference', value: ['my_resource', 'name', 'attr'] },
      });
    });
  });
});

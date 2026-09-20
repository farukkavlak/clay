import { describe, expect, it } from 'vitest';

import { ResourceBlock, VariableBlock } from '../src/ast';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

function makeParser(input: string): Parser {
  const lexer = new Lexer(input);
  return new Parser(lexer.tokenize());
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
      expect((result[0] as ResourceBlock).attributes.enabled).toEqual({ type: 'Boolean', value: false });
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

      expect((ast[0] as ResourceBlock).attributes.ref).toEqual({
        type: 'Reference',
        value: ['other_resource', 'field'],
      });
    });

    it('should parse deep references', () => {
      const input = `resource "r" "n" { ref = a.b.c.d }`;
      const parser = makeParser(input);
      const ast = parser.parse();

      expect((ast[0] as ResourceBlock).attributes.ref).toEqual({
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
      expect((result[0] as VariableBlock).attributes.default).toEqual({ type: 'Number', value: 8080 });
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
      expect((result[0] as VariableBlock).attributes.default).toEqual({ type: 'Boolean', value: true });
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

      expect((result[0] as VariableBlock).attributes.description).toEqual({ type: 'String', value: 'AWS region' });
    });
  });

  describe('Block kinds are names, not keywords', () => {
    it('takes a block kind as an attribute name', () => {
      const attributes = attributesOf('resource "null_resource" "a" { data = "x" module = 1 variable = true output = "y" resource = "z" }');

      expect(Object.keys(attributes)).toEqual(['data', 'module', 'variable', 'output', 'resource']);
    });

    it('takes a block kind as a map key', () => {
      const attributes = attributesOf('resource "null_resource" "a" { m = { data = "x", output = "y" } }');

      expect(attributes.m).toEqual({ type: 'Map', value: { data: { type: 'String', value: 'x' }, output: { type: 'String', value: 'y' } } });
    });

    it('refuses a top-level word that is not a block kind, even one an object has by birth', () => {
      for (const word of ['bogus', 'constructor', 'toString', '__proto__'])
        expect(() => makeParser(`${word} "x" {}`).parse()).toThrow(`[Line 1, Column 1] Unexpected token: ${word}`);
    });

    it('keeps a block kind in a reference', () => {
      const attributes = attributesOf('resource "null_resource" "a" { v = module.m.output }');

      expect(attributes.v).toEqual({ type: 'Reference', value: ['module', 'm', 'output'] });
    });

    it('still starts a block with the word, right after an attribute of the same name', () => {
      const program = makeParser('resource "null_resource" "a" { data = 1 }\ndata "local_file" "b" {}').parse();

      expect(program.map((statement) => statement.type)).toEqual(['Resource', 'Data']);
    });

    it('takes only "value" in an output block, not any name', () => {
      expect(() => makeParser('output "o" { data = 1 }').parse()).toThrow("[Line 1, Column 14] Expect 'value' in output block.");
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

      for (const [label, input] of Object.entries(twice)) expect(() => makeParser(input).parse()).toThrow(`[Line 2, Column 1] ${label} is declared twice`);
    });

    it('tells blocks of different kinds with one name apart', () => {
      const input = 'variable "x" {}\noutput "x" { value = "1" }\nmodule "x" { source = "./x" }\nresource "null_resource" "x" {}\nresource "local_file" "x" {}';

      expect(makeParser(input).parse()).toHaveLength(5);
    });

    it('should throw on missing resource type', () => {
      const input = `resource "name" { key = "val" }`;
      // resource (1:1) "name" (1:10) { (1:17) ...
      // Consumes "name" as type. Then sees {. Expects string (name).
      // Token at { is Line 1, Column 17.
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 17] Expect resource name string');
    });

    it('should throw on missing resource name', () => {
      const input = `resource "type" { key = "val" }`;
      // resource (1:1) "type" (1:10) { (1:17)
      // Consumes "type". Next is {. Expects name string.
      // Token at { is Line 1, Column 17.
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 17] Expect resource name string');
    });

    it('should throw on missing opening brace', () => {
      const input = `resource "type" "name" key = "val"`;
      // resource "type" "name" key (1:24)
      // Expects {. Got key (Identifier).
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow("[Line 1, Column 24] Expect '{'");
    });

    it('should throw on missing closing brace', () => {
      const input = `resource "type" "name" { key = "val"`;
      // EOF is next.
      // resource "type" "name" { key = "val" <EOF>
      // Lexer puts EOF at end.
      // Line 1. Column 37 (length is 36, so 37)
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow("[Line 1, Column 37] Expect '}'");
    });

    it('should throw on invalid attribute syntax (missing =)', () => {
      const input = `resource "type" "name" { key "val" }`;
      // key (1:26), "val" (1:30)
      // Expects =. Got "val" (String).
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow("[Line 1, Column 30] Expect '='");
    });

    it('should throw on invalid attribute key (not identifier)', () => {
      const input = `resource "type" "name" { "key" = "val" }`;
      // "key" is String at 1:26. Expect identifier.
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 26] Expect attribute name');
    });

    it('should throw on something that is not a value after =', () => {
      const input = `resource "type" "name" { key = = }`;
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 32] Unexpected value: =');
    });

    it('should throw on unexpected tokens at top level', () => {
      const input = `random_token "type" "name" {}`;
      // random_token is Identifier at 1:1.
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 1] Unexpected token: random_token');
    });

    it('should throw on invalid character in Lexer', () => {
      const input = `@`;
      // Lexer throws its own error format.
      // "Unexpected token at line 1, column 1: "@""
      expect(() => makeParser(input)).toThrow('Unexpected token at line 1, column 1: "@"');
    });

    it('should throw on invalid reference (missing property after dot)', () => {
      const input = `resource "type" "name" { ref = foo. }`;
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('Expect property name after dot');
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

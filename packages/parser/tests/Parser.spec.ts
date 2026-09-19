import { describe, expect, it } from 'vitest';

import { ResourceBlock, VariableBlock } from '../src/ast';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

function makeParser(input: string): Parser {
  const lexer = new Lexer(input);
  return new Parser(lexer.tokenize());
}

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

  describe('Error Cases', () => {
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

    it('should throw on invalid value type', () => {
      const input = `resource "type" "name" { key = resource }`;
      // resource is Keyword at 1:32.
      const parser = makeParser(input);
      expect(() => parser.parse()).toThrow('[Line 1, Column 32] Unexpected value: resource');
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

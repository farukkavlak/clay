import { ExactNumber } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ResourceBlock } from '../src/ast';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

describe('Complex Types Parsing', () => {
  it('should parse a simple list', () => {
    const input = `
      resource "test" "list" {
        items = ["a", "b", "c"]
      }
    `;
    const lexer = new Lexer(input, CONFIG_FILE);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    expect(ast[0].type).toBe('Resource');
    const resource = ast[0] as ResourceBlock;
    const items = resource.attributes.items;

    expect(items.type).toBe('List');
    if (items.type === 'List')
      expect(items.value).toMatchObject([
        { type: 'String', value: 'a' },
        { type: 'String', value: 'b' },
        { type: 'String', value: 'c' },
      ]);
  });

  it('should parse a list with mixed types', () => {
    const input = `
      resource "test" "mixed" {
        items = ["a", 1, true]
      }
    `;
    const lexer = new Lexer(input, CONFIG_FILE);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    const resource = ast[0] as ResourceBlock;
    const items = resource.attributes.items;

    expect(items.type).toBe('List');
    if (items.type === 'List') {
      expect(items.value).toHaveLength(3);
      expect(items.value[1]).toMatchObject({ type: 'Number', value: ExactNumber.parse('1') });
    }
  });

  it('should parse a map', () => {
    const input = `
      resource "test" "map" {
        config = {
          debug = true
          count = 42
          "version" = "1.0"
        }
      }
    `;
    const lexer = new Lexer(input, CONFIG_FILE);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    const resource = ast[0] as ResourceBlock;
    const config = resource.attributes.config;

    expect(config.type).toBe('Map');
    if (config.type === 'Map') {
      expect(config.value.debug).toMatchObject({ type: 'Boolean', value: true });
      expect(config.value.count).toMatchObject({ type: 'Number', value: ExactNumber.parse('42') });
      expect(config.value.version).toMatchObject({ type: 'String', value: '1.0' });
    }
  });

  it('should parse nested complex types', () => {
    const input = `
      resource "test" "nested" {
        matrix = [
          [1, 2],
          [3, 4]
        ]
        meta = {
          tags = ["web", "prod"]
          owner = {
            name = "admin"
          }
        }
      }
    `;
    const lexer = new Lexer(input, CONFIG_FILE);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    const resource = ast[0] as ResourceBlock;

    // Check nested list
    const matrix = resource.attributes.matrix;
    expect(matrix.type).toBe('List');
    if (matrix.type === 'List') {
      const firstRow = matrix.value[0];
      expect(firstRow.type).toBe('List');
      if (firstRow.type === 'List') expect(firstRow.value[0]).toMatchObject({ type: 'Number', value: ExactNumber.parse('1') });
    }

    // Check nested map
    const meta = resource.attributes.meta;
    expect(meta.type).toBe('Map');
    if (meta.type === 'Map') {
      expect(meta.value.tags.type).toBe('List');
      expect(meta.value.owner.type).toBe('Map');
      if (meta.value.owner.type === 'Map') expect(meta.value.owner.value.name).toMatchObject({ type: 'String', value: 'admin' });
    }
  });
});

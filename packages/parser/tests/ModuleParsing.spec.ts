import { ExactNumber } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ModuleBlock } from '../src/ast';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

function makeParser(input: string): Parser {
  const lexer = new Lexer(input, CONFIG_FILE);
  return new Parser(lexer.tokenize());
}

describe('Clay Parser - Modules', () => {
  it('should parse a simple module block', () => {
    const input = `
      module "vpc" {
        source = "./modules/vpc"
        env = "dev"
      }
    `;
    const parser = makeParser(input);
    const result = parser.parse();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'Module',
      name: 'vpc',
      attributes: {
        source: { type: 'String', value: './modules/vpc' },
        env: { type: 'String', value: 'dev' },
      },
    });
  });

  it('should parse module with multiple attributes', () => {
    const input = `
      module "app" {
        source = "./modules/app"
        instances = 3
        enabled = true
      }
    `;
    const parser = makeParser(input);
    const result = parser.parse();

    expect((result[0] as ModuleBlock).attributes).toMatchObject({
      source: { type: 'String', value: './modules/app' },
      instances: { type: 'Number', value: ExactNumber.parse('3') },
      enabled: { type: 'Boolean', value: true },
    });
  });

  it('should parse module with variable references', () => {
    const input = `
      module "db" {
        source = "./modules/db"
        vpc_id = module.vpc.id
      }
    `;
    const parser = makeParser(input);
    const result = parser.parse();

    expect((result[0] as ModuleBlock).attributes.vpc_id).toMatchObject({
      type: 'Reference',
      value: ['module', 'vpc', 'id'],
    });
  });

  it('should throw on missing module name', () => {
    const input = `module { source = "./x" }`;
    const parser = makeParser(input);
    expect(() => parser.parse()).toThrow('Expect module name string');
  });

  it('should allow empty module block', () => {
    const input = `module "empty" {}`;
    const parser = makeParser(input);
    const result = parser.parse();
    expect(result).toHaveLength(1);
    expect((result[0] as ModuleBlock).attributes).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, DataBlock } from '../src/ast';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';

describe('Parser - Data Blocks', () => {
  it('should parse a valid data block', () => {
    const input = `
      data "aws_ami" "ubuntu" {
        most_recent = true
        owner = "099720109477"
      }
    `;
    const tokens = new Lexer(input, CONFIG_FILE).tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    expect(ast).to.have.lengthOf(1);
    const block = ast[0] as DataBlock;

    expect(block.type).to.equal('Data');
    expect(block.dataSourceType).to.equal('aws_ami');
    expect(block.name).to.equal('ubuntu');
    expect(block.attributes.most_recent).toMatchObject({ type: 'Boolean', value: true });
    expect(block.attributes.owner).toMatchObject({ type: 'String', value: '099720109477' });
  });

  it('should parse data block with supported values', () => {
    const input = `
      data "local_file" "foo" {
        filename = "/tmp/foo.txt"
        id = 123
      }
    `;
    const tokens = new Lexer(input, CONFIG_FILE).tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    expect(ast).to.have.lengthOf(1);
    const block = ast[0] as DataBlock;

    expect(block.type).to.equal('Data');
    expect(block.dataSourceType).to.equal('local_file');
    expect(block.name).to.equal('foo');
    expect(block.attributes.filename).toMatchObject({ type: 'String', value: '/tmp/foo.txt' });
    expect(block.attributes.id).toMatchObject({ type: 'Number', value: 123 });
  });

  it('should parse multiple data blocks', () => {
    const input = `
      data "type1" "name1" {}
      data "type2" "name2" {}
    `;
    const tokens = new Lexer(input, CONFIG_FILE).tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    expect(ast).to.have.lengthOf(2);
    expect((ast[0] as DataBlock).name).to.equal('name1');
    expect((ast[1] as DataBlock).name).to.equal('name2');
  });

  it('should throw error for incomplete data block', () => {
    const input = `data "type"`;
    // Missing name and body
    const tokens = new Lexer(input, CONFIG_FILE).tokenize();
    const parser = new Parser(tokens);

    expect(() => parser.parse()).to.throw('Expect data source name string');
  });

  it('should throw error for missing type', () => {
    const input = `data { }`;
    const tokens = new Lexer(input, CONFIG_FILE).tokenize();
    const parser = new Parser(tokens);

    expect(() => parser.parse()).to.throw('Expect data source type string');
  });
});

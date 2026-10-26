import { ModuleAddress, Schema, types } from '@clay/contracts';
import { CONFIG_FILE, Lexer, Parser, ResourceBlock } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { checkNames } from '../../src/checks/checkAttributes';

const schema: Schema = {
  name: { type: types.string, required: true },
  tags: { type: types.map(types.string), optional: true },
  members: { type: types.set(types.string), optional: true },
  items: { type: types.list(types.string), optional: true },
};

const block = (ignore: string): ResourceBlock => {
  const source = `resource "t" "a" {\n  name = "x"\n  lifecycle {\n    ignore_changes = ${ignore}\n  }\n}`;
  return new Parser(new Lexer(source, CONFIG_FILE).tokenize()).parse()[0] as ResourceBlock;
};

describe('ignore_changes names', () => {
  it.each(['all', '[]', '[name]', '[tags["a"]]', '[items[0]]', '[members]', '[name, tags["a"]]'])('accepts %s', (ignore) => {
    expect(() => {
      checkNames(block(ignore), schema, ModuleAddress.root);
    }).not.toThrow();
  });

  it('refuses an attribute the type does not have, at its place in the list', () => {
    expect(() => {
      checkNames(block('[name, nope]'), schema, ModuleAddress.root);
    }).toThrow('ignore_changes names "nope", which t does not have');
  });

  it.each(['[members[0]]', '[members["a"]]'])('refuses a path into a set, %s, whose items have no place to name', (ignore) => {
    expect(() => {
      checkNames(block(ignore), schema, ModuleAddress.root);
    }).toThrow('ignore_changes cannot reach into "members", a set: its items have no place to name');
  });
});

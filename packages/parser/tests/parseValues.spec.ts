import { describe, expect, it } from 'vitest';

import { parseValues } from '../src/Parser';

describe('parseValues', () => {
  it('reads each name and its value, placed in the file', () => {
    expect(parseValues('region = "eu"\nports  = [80]\n', 'prod.clayvars')).toMatchObject([
      { type: 'Attribute', name: 'region', value: { type: 'String', value: 'eu' }, position: { file: 'prod.clayvars', line: 1, column: 1 } },
      { type: 'Attribute', name: 'ports', value: { type: 'List' }, position: { file: 'prod.clayvars', line: 2, column: 1 } },
    ]);
  });

  it('reads an empty file as no value', () => {
    expect(parseValues('# nothing yet\n', 'prod.clayvars')).toEqual([]);
  });

  it('refuses a block, which a variables file does not hold', () => {
    expect(() => parseValues('variable "x" {}', 'prod.clayvars')).toThrow(
      expect.objectContaining({
        message: "Expect '=' after the variable name: a variables file holds only name = value.",
        position: { file: 'prod.clayvars', line: 1, column: 10 },
      })
    );
  });

  it('refuses what is not a name where a name starts', () => {
    expect(() => parseValues('"x" = 1', 'prod.clayvars')).toThrow(
      expect.objectContaining({ message: 'Expect a variable name.', position: { file: 'prod.clayvars', line: 1, column: 1 } })
    );
  });

  it('refuses a name given twice, at the second', () => {
    expect(() => parseValues('x = 1\ny = 2\nx = 3', 'prod.clayvars')).toThrow(
      expect.objectContaining({ message: '"x" is given twice, first on line 1', position: { file: 'prod.clayvars', line: 3, column: 1 } })
    );
  });
});

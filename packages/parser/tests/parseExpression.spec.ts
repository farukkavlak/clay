import { describe, expect, it } from 'vitest';

import { parseExpression } from '../src/Parser';

describe('parseExpression', () => {
  it('reads one value, placed in the file it is given', () => {
    expect(parseExpression('[80, 443]', '--var ports')).toMatchObject({
      type: 'List',
      value: [
        { type: 'Number', position: { file: '--var ports', line: 1, column: 2 } },
        { type: 'Number', position: { file: '--var ports', line: 1, column: 6 } },
      ],
      position: { file: '--var ports', line: 1, column: 1 },
    });
  });

  it('refuses what follows the value, where it starts', () => {
    expect(() => parseExpression('"a" "b"', '--var x')).toThrow(
      expect.objectContaining({ message: 'Expect the value to end here.', position: { file: '--var x', line: 1, column: 5 } })
    );
  });

  it('refuses an empty text', () => {
    expect(() => parseExpression('', '--var x')).toThrow(expect.objectContaining({ position: { file: '--var x', line: 1, column: 1 } }));
  });
});

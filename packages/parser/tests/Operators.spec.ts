import { describe, expect, it } from 'vitest';

import { AttributeValue, namedIn, ResourceBlock } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { Lexer } from '../src/Lexer';
import { Parser } from '../src/Parser';
import { TokenType } from '../src/tokens';

const at = (column: number) => ({ file: 'main.clay', line: 1, column });

const PREFIX = 'resource "t" "n" { v = ';

/** The value of `v`, with positions counted from the start of what is written. */
const valueOf = (written: string): AttributeValue => (new Parser(new Lexer(`${PREFIX}${written} }`, 'main.clay').tokenize()).parse()[0] as ResourceBlock).attributes.v;

const column = (written: string, needle: string, from = 0) => PREFIX.length + written.indexOf(needle, from) + 1;

/** The tree without positions, operators as `[left, operator, right]`, so a test reads how it groups. */
type Shape = string | boolean | null | Shape[] | { [key: string]: Shape };

/** What needs no shape of its parts. */
function leafShape(value: AttributeValue): Shape | undefined {
  if (value.type === 'Number') return value.value.toString();
  if (value.type === 'Reference') return value.value.map((step) => ('name' in step ? step.name : '[]')).join('.');
  if (value.type === 'Boolean') return value.value;
  if (value.type === 'Null') return null;

  return undefined;
}

function shapeOf(value: AttributeValue): Shape {
  const leaf = leafShape(value);
  if (leaf !== undefined) return leaf;
  if (value.type === 'Binary') return [shapeOf(value.left), value.operator, shapeOf(value.right)];
  if (value.type === 'Not') return ['!', shapeOf(value.value)];
  if (value.type === 'Negate') return ['-', shapeOf(value.value)];
  if (value.type === 'Conditional') return [shapeOf(value.condition), '?', shapeOf(value.whenTrue), ':', shapeOf(value.whenFalse)];
  if (value.type === 'List') return value.value.map((item) => shapeOf(item));
  if (value.type === 'For') return { for: shapeOf(value.collection), body: shapeOf(value.body) };

  return value.type === 'Map' ? Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, shapeOf(item)])) : value.type;
}

const shape = (written: string) => shapeOf(valueOf(written));

function errorOf(written: string): ConfigError {
  try {
    valueOf(written);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${written}`);
}

describe('operators', () => {
  it.each([
    ['==', TokenType.Equal],
    ['!=', TokenType.NotEqual],
    ['&&', TokenType.And],
    ['||', TokenType.Or],
    ['!', TokenType.Bang],
    ['?', TokenType.Question],
    ['+', TokenType.Plus],
    ['-', TokenType.Minus],
    ['*', TokenType.Star],
    ['/', TokenType.Slash],
    ['%', TokenType.Percent],
    ['<', TokenType.Less],
    ['<=', TokenType.LessEqual],
    ['>', TokenType.Greater],
    ['>=', TokenType.GreaterEqual],
    ['=>', TokenType.FatArrow],
    ['=', TokenType.Assign],
  ])('reads %s as one token', (written, type) => {
    const [token] = new Lexer(written, 'main.clay').tokenize();

    expect(token).toEqual({ type, value: written, position: { file: 'main.clay', line: 1, column: 1 } });
  });

  it.each([
    ['&& before ||', 'a.x || b.x && c.x', ['a.x', '||', ['b.x', '&&', 'c.x']]],
    ['&& before || on the left too', 'a.x && b.x || c.x', [['a.x', '&&', 'b.x'], '||', 'c.x']],
    ['== and != before &&', 'a.x == b.x && c.x != d.x', [['a.x', '==', 'b.x'], '&&', ['c.x', '!=', 'd.x']]],
    ['! before ==', '!a.x == b.x', [['!', 'a.x'], '==', 'b.x']],
    ['the left first within a level', 'a.x && b.x && c.x', [['a.x', '&&', 'b.x'], '&&', 'c.x']],
    ['== and != from the left alike', 'a.x == b.x != c.x', [['a.x', '==', 'b.x'], '!=', 'c.x']],
    ['parentheses before anything', '(a.x || b.x) && c.x', [['a.x', '||', 'b.x'], '&&', 'c.x']],
    ['a conditional after every operator', 'a.x || b.x ? c.x : d.x', [['a.x', '||', 'b.x'], '?', 'c.x', ':', 'd.x']],
    ['a conditional in the false result to the right', 'a.x ? b.x : c.x ? d.x : e.x', ['a.x', '?', 'b.x', ':', ['c.x', '?', 'd.x', ':', 'e.x']]],
    ['a conditional in the true result', 'a.x ? b.x ? c.x : d.x : e.x', ['a.x', '?', ['b.x', '?', 'c.x', ':', 'd.x'], ':', 'e.x']],
    ['! twice', '!!a.x', ['!', ['!', 'a.x']]],
    ['* before +', 'a.x + b.x * c.x', ['a.x', '+', ['b.x', '*', 'c.x']]],
    ['/ and % before -', 'a.x - b.x / c.x % d.x', ['a.x', '-', [['b.x', '/', 'c.x'], '%', 'd.x']]],
    ['*, / and % from the left alike', 'a.x / b.x * c.x', [['a.x', '/', 'b.x'], '*', 'c.x']],
    ['// as a comment, not two divisions', 'a.x // b.x\n', 'a.x'],
    ['* before - on the left too', 'a.x * b.x - c.x', [['a.x', '*', 'b.x'], '-', 'c.x']],
    ['+ and - from the left alike', 'a.x - b.x + c.x', [['a.x', '-', 'b.x'], '+', 'c.x']],
    ['+ before <', 'a.x + 1 < b.x', [['a.x', '+', '1'], '<', 'b.x']],
    ['< before ==', 'a.x < b.x == c.x >= d.x', [['a.x', '<', 'b.x'], '==', ['c.x', '>=', 'd.x']]],
    ['ordering from the left', 'a.x <= b.x > c.x', [['a.x', '<=', 'b.x'], '>', 'c.x']],
    ['a minus between two numbers as a subtraction', '3-1', ['3', '-', '1']],
    ['a minus before a number as part of it', '2 * -1', ['2', '*', '-1']],
    ['a minus before anything else as a negation', '-a.x * b.x', [['-', 'a.x'], '*', 'b.x']],
    ['a negation before the steps it reads', '-a.x[0]', ['-', 'a.x.[]']],
    ['two minuses', '--1', ['-', '-1']],
    ['! and - together', '!-a.x', ['!', ['-', 'a.x']]],
  ])('groups %s', (_, written, grouped) => {
    expect(shape(written)).toEqual(grouped);
  });

  it.each([
    ['a list item', '[a.x == null, true]', [['a.x', '==', null], true]],
    ['a map value', '{ k = !a.x }', { k: ['!', 'a.x'] }],
    ['the collection of a for, before its colon', '[for i in a.x ? b.x : c.x : i]', { for: ['a.x', '?', 'b.x', ':', 'c.x'], body: 'Bound' }],
    ['the body of a for', '[for i in a.x : i == null]', { for: 'a.x', body: ['Bound', '==', null] }],
  ])('reads operators in %s', (_, written, grouped) => {
    expect(shape(written)).toEqual(grouped);
  });

  it('places an operation where it starts, and keeps where its operator is', () => {
    const written = 'a.x && b.x == c.x';

    expect(valueOf(written)).toMatchObject({
      position: at(column(written, 'a.x')),
      operatorPosition: at(column(written, '&&')),
      right: { position: at(column(written, 'b.x')), operatorPosition: at(column(written, '==')) },
    });
  });

  it('places a conditional at its condition and a negation at its !', () => {
    const written = '!a.x ? b.x : c.x';

    expect(valueOf(written)).toMatchObject({ type: 'Conditional', position: at(column(written, '!')), condition: { type: 'Not', position: at(column(written, '!')) } });
  });

  it('places what is in parentheses where it starts inside them', () => {
    const written = '(a.x)';

    expect(valueOf(written)).toMatchObject({ type: 'Reference', position: at(column(written, 'a.x')) });
  });

  it('finds the references on every side', () => {
    const named = namedIn(valueOf('!a.x == b.x ? c.x : d.x'));

    expect(named.map((node) => node.type === 'Reference' && node.value[0])).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]);
  });

  it.each([
    ['a conditional with no colon', 'a.x ? b.x', "Expect ':' after the value a conditional gives when true.", '}'],
    ['parentheses never closed', '(a.x', "Expect ')' after the value in parentheses.", '}'],
    ['an operator with nothing after it', 'a.x == ', 'Unexpected value: }', '}'],
    ['an operator with nothing before it', '&& a.x', 'Unexpected value: &&', '&&'],
  ])('refuses %s', (_, written, message, place) => {
    const error = errorOf(written);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(PREFIX.length + `${written} }`.indexOf(place) + 1));
  });
});

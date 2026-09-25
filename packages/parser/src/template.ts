import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';

/** A piece of a string's text: plain text, or what one `${ … }` holds and where that begins. */
export type Piece = { kind: 'text'; text: string } | { kind: 'interpolation'; text: string; position: Position };

/** What starts at one place in a string: text, or an interpolation's inside, with the raw text it was written as. */
type Step = { text: string; raw: string } | { interpolation: string; raw: string };

const ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['"', '"'],
  ['\\', '\\'],
]);

const HEX_DIGITS = new Map([
  ['u', 4],
  ['U', 8],
]);

const KNOWN = '\\n, \\r, \\t, \\", \\\\, \\uNNNN, \\UNNNNNNNN and $${';

/** A character by number; half of a pair JavaScript writes a character in two with is none. */
function character(hex: string, digits: number): string | undefined {
  if (hex.length !== digits || !/^[\dA-Fa-f]+$/.test(hex)) return undefined;

  const code = Number.parseInt(hex, 16);
  if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return undefined;

  return String.fromCodePoint(code);
}

function escapeAt(raw: string, cursor: number, position: Position): Step {
  const letter = String.fromCodePoint(raw.codePointAt(cursor + 1) as number);
  const plain = ESCAPES.get(letter);
  if (plain !== undefined) return { text: plain, raw: `\\${letter}` };

  const digits = HEX_DIGITS.get(letter);
  if (digits === undefined) {
    // A line break inside quotes would split the message it is shown in.
    const problem = /[\n\r]/.test(letter) ? 'A backslash ends the line' : `Unknown escape "\\${letter}"`;
    throw new ConfigError(`${problem}; a string knows ${KNOWN}`, position);
  }

  const written = raw.slice(cursor, cursor + 2 + digits);
  const text = character(written.slice(2), digits);
  if (text === undefined) throw new ConfigError(`"${written}" is not a character: \\u takes four hex digits and \\U eight, naming a Unicode character`, position);

  return { text, raw: written };
}

function stepAt(raw: string, cursor: number, position: Position): Step {
  if (raw.startsWith('$${', cursor)) return { text: '${', raw: '$${' };

  if (raw.startsWith('${', cursor)) {
    const close = raw.indexOf('}', cursor);
    if (close === -1) throw new ConfigError("This '${' is never closed with '}'", position);

    return { interpolation: raw.slice(cursor + 2, close), raw: raw.slice(cursor, close + 1) };
  }

  if (raw[cursor] === '\\') return escapeAt(raw, cursor, position);

  const char = String.fromCodePoint(raw.codePointAt(cursor) as number);
  return { text: char, raw: char };
}

/**
 * Splits a string's text at each `${ … }` and reads its escapes. An escape is read in the text only, so `$${` stays text.
 * `start` is where the text begins, so every piece knows where it was written.
 */
export function splitTemplate(raw: string, start: Position): Piece[] {
  const pieces: Piece[] = [];
  let text = '';
  let cursor = 0;
  let position = start;

  while (cursor < raw.length) {
    const step = stepAt(raw, cursor, position);

    if ('interpolation' in step) {
      if (text !== '') pieces.push({ kind: 'text', text });
      text = '';
      pieces.push({ kind: 'interpolation', text: step.interpolation, position: advanced(position, '${') });
    } else text += step.text;

    position = advanced(position, step.raw);
    cursor += step.raw.length;
  }

  if (text !== '') pieces.push({ kind: 'text', text });

  return pieces;
}

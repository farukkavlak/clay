import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';

type Step = { text: string; raw: string };

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

/** Undefined for a lone surrogate. */
function character(hex: string, digits: number): string | undefined {
  if (hex.length !== digits || !/^[\dA-Fa-f]+$/.test(hex)) return undefined;

  const code = Number.parseInt(hex, 16);
  if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return undefined;

  return String.fromCodePoint(code);
}

// A non-printing character would garble the message, so it is shown by code point.
function unknown(letter: string): string {
  if (!/\p{C}/u.test(letter)) return `Unknown escape "\\${letter}"`;

  const code = (letter.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
  return `Unknown escape: a backslash before U+${code}`;
}

function escapeAt(raw: string, cursor: number, position: Position): Step {
  const letter = String.fromCodePoint(raw.codePointAt(cursor + 1) as number);
  const plain = ESCAPES.get(letter);
  if (plain !== undefined) return { text: plain, raw: `\\${letter}` };

  const digits = HEX_DIGITS.get(letter);
  if (digits === undefined) throw new ConfigError(`${unknown(letter)}; a string knows ${KNOWN}`, position);

  const written = raw.slice(cursor, cursor + 2 + digits);
  const text = character(written.slice(2), digits);
  if (text === undefined) throw new ConfigError(`"${written}" is not a character: \\u takes four hex digits and \\U eight, naming a Unicode character`, position);

  return { text, raw: written };
}

function stepAt(raw: string, cursor: number, position: Position): Step {
  if (raw.startsWith('$${', cursor)) return { text: '${', raw: '$${' };
  if (raw[cursor] === '\\') return escapeAt(raw, cursor, position);

  const char = String.fromCodePoint(raw.codePointAt(cursor) as number);
  return { text: char, raw: char };
}

/** `start` places the error for a bad escape. */
export function readEscapes(raw: string, start: Position): string {
  let text = '';
  let cursor = 0;
  let position = start;

  while (cursor < raw.length) {
    const step = stepAt(raw, cursor, position);

    text += step.text;
    position = advanced(position, step.raw);
    cursor += step.raw.length;
  }

  return text;
}

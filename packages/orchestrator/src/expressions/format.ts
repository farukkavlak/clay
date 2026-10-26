import { containsUnknown, ExactNumber, isRecord, isUnknown, jsonText, NumberError, SENSITIVE, Type, UNKNOWN } from '@clay/contracts';

import { charactersOf } from './characters';
import { shown } from '../shown';
import { article, inferred, nullSource, Value } from '../values/Value';
import { isSensitive } from '../values/sensitive';

/** A problem with the string, at 0, or with the argument `at` after it. */
export class FormatError extends Error {
  override name = 'FormatError';

  constructor(
    message: string,
    readonly at: number
  ) {
    super(message);
  }
}

interface Verb {
  readonly raw: string;
  readonly letter: string;
  readonly flags: string;
  readonly width?: number;
  readonly precision?: number;
  /** The argument it writes, counted from 0 after the string. */
  readonly arg: number;
}

type Piece = string | Verb;

/** Flags, a width, a precision and an argument index, each left out where not written. */
const PIECE = /%%|%([-+ #0]*)(\d*)(?:\.(\d*))?(?:\[(\d*)\])?(.?)/gsu;

/** Caps a width and a precision, so a typo cannot build a string too long to hold. */
const MAX_SIZE = 1000;

interface Writing {
  readonly verb: Verb;
  readonly value: Value;
  /** The string is sensitive, so a message tells nothing of the verb. */
  readonly hidden: boolean;
}

function namedIn({ verb, hidden }: Pick<Writing, 'verb' | 'hidden'>): string {
  return hidden ? 'a verb of its sensitive string' : JSON.stringify(verb.raw);
}

interface Rule {
  readonly flags: string;
  readonly precision: boolean;
  /** Every kind where left out. */
  readonly takes?: readonly Type['kind'][];
  readonly write: (writing: Writing) => string;
}

function padded({ width, flags }: Verb, text: string, fill = flags.includes('0') ? '0' : ' '): string {
  const missing = (width ?? 0) - charactersOf(text).length;
  if (missing <= 0) return text;

  return flags.includes('-') ? text + ' '.repeat(missing) : fill.repeat(missing) + text;
}

/** A precision keeps at most that many characters of a string. */
function cut({ precision }: Verb, text: string): string {
  return precision === undefined ? text : charactersOf(text).slice(0, precision).join('');
}

function refused(writing: Writing, takes: string, problem?: string): never {
  const what = isSensitive(writing.value) ? SENSITIVE : shown(writing.value.data);
  const why = writing.hidden ? '' : `, which takes ${takes}${problem === undefined ? '' : `; it ${problem}`}`;
  throw new FormatError(`format cannot write ${what} with ${namedIn(writing)}${why}`, writing.verb.arg + 1);
}

function numberOf(writing: Writing, takes: string): ExactNumber {
  const { data } = writing.value;
  if (data instanceof ExactNumber) return data;

  try {
    return ExactNumber.parse(data as string);
  } catch (error) {
    if (error instanceof NumberError) return refused(writing, takes, error.problem);
    throw error;
  }
}

function signOf({ flags }: Verb, negative: boolean): string {
  if (negative) return '-';

  return flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
}

/** Zeros from a `0` flag go after the sign and the prefix, as Go writes them. */
function signed(verb: Verb, text: string, prefix: string, zeros: boolean): string {
  const lead = signOf(verb, text.startsWith('-')) + prefix;
  const digits = text.replace(/^-/u, '');
  const filled = zeros && verb.flags.includes('0') && !verb.flags.includes('-') ? digits.padStart((verb.width ?? 0) - lead.length, '0') : digits;

  return padded(verb, lead + filled, ' ');
}

const BASES: Record<string, { readonly base: number; readonly prefix: string }> = {
  d: { base: 10, prefix: '' },
  b: { base: 2, prefix: '0b' },
  o: { base: 8, prefix: '0' },
  x: { base: 16, prefix: '0x' },
  X: { base: 16, prefix: '0X' },
};

/** As Go writes an integer: the precision is the fewest digits, `#` writes the prefix of the base, and `0` pads where no precision is given. Zero at precision 0 is only the width. */
function integer(writing: Writing): string {
  const { verb } = writing;
  const number = numberOf(writing, 'a whole number');
  const text = number.toString();
  if (text.includes('.')) return refused(writing, 'a whole number');
  if (verb.precision === 0 && number.isZero()) return padded(verb, '', ' ');

  const { base, prefix } = BASES[verb.letter];
  const unsigned = BigInt(text.replace(/^-/u, '')).toString(base);
  const digits = unsigned.padStart(verb.precision ?? 0, '0');
  const written = signed(verb, (text.startsWith('-') ? '-' : '') + digits, verb.flags.includes('#') ? prefix : '', verb.precision === undefined);

  return verb.letter === 'X' ? written.toUpperCase() : written;
}

/** At least two digits in the exponent, as Go writes it: `1.5e+03`. */
function exponential(text: string): string {
  return text.replace(/e([+-])(\d)$/u, 'e$10$2');
}

function significantDigits(number: ExactNumber): number {
  return number.toString().replaceAll(/[-.]/gu, '').replace(/^0+/u, '').replace(/0+$/u, '').length;
}

/**
 * As Go writes %g: rounded to `precision` significant digits, or every digit where none is given, and without trailing zeros.
 * It is %e where the exponent is below -4 or at least the digits kept, or 6 where none is given, and plain otherwise.
 */
function general(number: ExactNumber, precision?: number): string {
  if (number.isZero()) return '0';

  const kept = Math.max(precision ?? significantDigits(number), 1);
  const [mantissa, power] = number.toExponential(kept - 1).split('e');
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replaceAll(/[-.]/gu, '').replace(/0+$/u, '');
  const exponent = Number(power);
  const limit = precision === undefined ? 6 : kept;

  if (exponent < -4 || exponent >= limit) return exponential(`${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${power}`);
  return sign + ExactNumber.parse(`${digits}e${exponent - digits.length + 1}`).toString();
}

const DECIMALS: Record<string, (number: ExactNumber, precision?: number) => string> = {
  f: (number, precision = 6) => number.toFixed(precision),
  e: (number, precision = 6) => exponential(number.toExponential(precision)),
  E: (number, precision = 6) => exponential(number.toExponential(precision)).toUpperCase(),
  g: general,
  G: (number, precision) => general(number, precision).toUpperCase(),
};

/** Rounded half to even on the number as written, where Terraform rounds the nearest binary fraction. */
function decimal(writing: Writing): string {
  const { verb } = writing;

  return signed(verb, DECIMALS[verb.letter](numberOf(writing, 'a number'), verb.precision), '', true);
}

function boolean(writing: Writing): string {
  const { data } = writing.value;
  if (typeof data !== 'boolean' && data !== 'true' && data !== 'false') return refused(writing, 'true or false');

  return padded(writing.verb, String(data));
}

/** Keys in order, so the same map always writes the same text. */
function sortedKeys(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => sortedKeys(item));
  if (!isRecord(data)) return data;

  return Object.fromEntries(
    Object.keys(data)
      .sort()
      .map((key) => [key, sortedKeys(data[key])])
  );
}

/** A string, a number or a boolean as `${}` writes it, and anything else, or anything with `#`, as JSON. */
function asIs({ verb, value: { data } }: Writing): string {
  const json = verb.flags.includes('#') || (typeof data === 'object' && !(data instanceof ExactNumber));

  return padded(verb, json ? jsonText(sortedKeys(data)) : String(data));
}

const TEXT: readonly Type['kind'][] = ['string', 'number', 'bool'];
const NUMBER: readonly Type['kind'][] = ['number', 'string'];

const RULES: Record<string, Rule> = {
  s: { flags: '-0', precision: true, takes: TEXT, write: ({ verb, value }) => padded(verb, cut(verb, String(value.data))) },
  q: { flags: '-0', precision: true, takes: TEXT, write: ({ verb, value }) => padded(verb, jsonText(cut(verb, String(value.data)))) },
  v: { flags: '-#', precision: false, write: asIs },
  t: { flags: '-', precision: false, takes: ['bool', 'string'], write: boolean },
  d: { flags: '-+ 0', precision: true, takes: NUMBER, write: integer },
  b: { flags: '-+ 0#', precision: true, takes: NUMBER, write: integer },
  o: { flags: '-+ 0#', precision: true, takes: NUMBER, write: integer },
  x: { flags: '-+ 0#', precision: true, takes: NUMBER, write: integer },
  X: { flags: '-+ 0#', precision: true, takes: NUMBER, write: integer },
  f: { flags: '-+ 0', precision: true, takes: NUMBER, write: decimal },
  e: { flags: '-+ 0', precision: true, takes: NUMBER, write: decimal },
  E: { flags: '-+ 0', precision: true, takes: NUMBER, write: decimal },
  g: { flags: '-+ 0', precision: true, takes: NUMBER, write: decimal },
  G: { flags: '-+ 0', precision: true, takes: NUMBER, write: decimal },
};

const VERBS = '%s, %q, %v, %t, %d, %b, %o, %x, %X, %f, %e, %E, %g, %G and %%';

function sizeOf(text: string, unreadable: (reason: string) => FormatError): number {
  const size = Number(text);
  if (size > MAX_SIZE) throw unreadable(`a width or a precision is at most ${MAX_SIZE}`);
  return size;
}

function checkRule(letter: string, flags: string, precision: string | undefined, unreadable: (reason: string) => FormatError): void {
  if (!Object.hasOwn(RULES, letter)) throw unreadable(letter === '' ? 'the string ends before a verb' : `there is no verb %${letter}; format takes ${VERBS}`);

  const rule = RULES[letter];
  const flag = [...flags].find((written) => !rule.flags.includes(written));
  if (flag !== undefined) throw unreadable(`%${letter} takes no ${JSON.stringify(flag)} flag`);
  if (precision !== undefined && !rule.precision) throw unreadable(`%${letter} takes no precision`);
}

function argOf(index: string | undefined, next: number, given: number, unreadable: (reason: string) => FormatError): number {
  if (index !== undefined && !/^[1-9]\d*$/.test(index)) throw unreadable('an argument is picked as [1], [2] and so on');

  const arg = index === undefined ? next : Number(index) - 1;
  if (arg >= given) throw unreadable(`it needs argument ${arg + 1} after the string, and there ${given === 1 ? 'is' : 'are'} ${given}`);
  return arg;
}

/** A sensitive string's verbs are parts of it, so a problem with one does not show it. */
function verbOf(match: RegExpExecArray, next: number, given: number, hidden: boolean): Verb {
  const [raw, flags, width, precision, index, letter] = match;
  const unreadable = (reason: string) =>
    new FormatError(hidden ? `format cannot read a verb in its string; it is sensitive, so its parts are not shown` : `format cannot read ${JSON.stringify(raw)}: ${reason}`, 0);

  checkRule(letter, flags, precision, unreadable);
  return {
    raw,
    letter,
    flags,
    width: width === '' ? undefined : sizeOf(width, unreadable),
    // `%.d` is precision 0, as in Go.
    precision: precision === undefined ? undefined : sizeOf(precision || '0', unreadable),
    arg: argOf(index, next, given, unreadable),
  };
}

function piecesOf(text: string, given: number, hidden: boolean): Piece[] {
  const pieces: Piece[] = [];
  let end = 0;
  let next = 0;

  for (const match of text.matchAll(PIECE)) {
    pieces.push(text.slice(end, match.index));
    end = match.index + match[0].length;

    const verb = match[0] === '%%' ? '%' : verbOf(match, next, given, hidden);
    if (typeof verb !== 'string') next = verb.arg + 1;
    pieces.push(verb);
  }
  pieces.push(text.slice(end));
  return pieces;
}

function checkUsed(pieces: Piece[], given: number): void {
  const used = new Set(pieces.flatMap((piece) => (typeof piece === 'string' ? [] : [piece.arg])));
  const left = Array.from({ length: given }, (_, arg) => arg).find((arg) => !used.has(arg));

  if (left !== undefined) throw new FormatError("format's string has no verb for this argument", left + 1);
}

/** Checked by type first, so `validate` finds a wrong one before it is known. */
function written(verb: Verb, value: Value, hidden: boolean): string | typeof UNKNOWN {
  const rule = RULES[verb.letter];
  const named = namedIn({ verb, hidden });
  const at = verb.arg + 1;

  if (value.data === null) {
    if (verb.letter === 'v') return padded(verb, 'null');
    throw new FormatError(`format cannot write null with ${named}${hidden ? '' : '; only %v writes null'}${nullSource(value)}`, at);
  }
  // A value of type `dynamic` is checked by what it holds, once that is known.
  const { kind } = value.type.kind === 'dynamic' && !isUnknown(value.data) ? inferred(value.data) : value.type;
  if (rule.takes && kind !== 'dynamic' && !rule.takes.includes(kind)) throw new FormatError(`format cannot write ${article(kind)} with ${named}`, at);
  if (containsUnknown(value.data)) return UNKNOWN;

  return rule.write({ verb, value, hidden });
}

/** The text, or UNKNOWN where an argument a verb writes is not known yet. Every argument is checked as far as it is known. */
export function formatted(text: string, values: Value[], hidden: boolean): string | typeof UNKNOWN {
  const pieces = piecesOf(text, values.length, hidden);
  checkUsed(pieces, values.length);

  const parts = pieces.map((piece) => (typeof piece === 'string' ? piece : written(piece, values[piece.arg], hidden)));
  return parts.includes(UNKNOWN) ? UNKNOWN : (parts as string[]).join('');
}

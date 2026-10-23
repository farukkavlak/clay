import { MAX_FILE_NESTING, NestingError, nestingOf } from './nesting';

// Node 22.13, the engines floor, has JSON.rawJSON and the reviver's source; the es2022 lib typings have neither.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
    parse(text: string, reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown): unknown;
  }
}

/** JSON's number syntax plus leading zeros, since a configuration may write `007`. */
const NUMERAL = /^(-)?(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/;

/** Caps the exponent, which would round past 2^53, and the length of the plain form. */
const MAX_PLACES = 1000;

/** A quotient's significant digits, as decimal128 keeps; most have no end. */
const QUOTIENT_DIGITS = 34;

const OUT_OF_RANGE = `is out of range: a number reaches at most ${MAX_PLACES} places either side of the point`;

/** Its own class, so a caller can catch it and rethrow anything else. */
export class NumberError extends Error {
  override name = 'NumberError';

  constructor(
    message: string,
    /** The message without the number, for a caller that may not show it. */
    readonly problem: string
  ) {
    super(message);
  }
}

/** Half to even: up past the half, and at it only to an even last digit. */
function rounded(quotient: bigint, rest: bigint, divisor: bigint): bigint {
  const twice = rest * 2n;
  const up = twice > divisor || (twice === divisor && quotient % 2n === 1n);

  return up ? quotient + 1n : quotient;
}

/** Shortens a long number in an error message. */
function shown(text: string, quote = ''): string {
  return text.length <= 40 ? `${quote}${text}${quote}` : `${quote}${text.slice(0, 20)}…${quote} (${text.length} characters)`;
}

/**
 * A number kept exactly as written; JavaScript numbers round past 2^53 and in most decimals.
 * The value is `digits × 10^exponent` with no zero at either end of `digits`, so each number has one form and compares equal however it was written.
 */
export class ExactNumber {
  private constructor(
    private readonly negative: boolean,
    private readonly digits: string,
    private readonly exponent: number
  ) {}

  static parse(text: string): ExactNumber {
    const refused = (problem: string) => new NumberError(`${shown(text, '"')} ${problem}`, problem);
    const match = NUMERAL.exec(text);
    if (!match) throw refused('is not a number');

    const [, sign, whole, fraction = '', exponent = '0'] = match;
    const number = ExactNumber.normalized(sign === '-', whole + fraction, Number(exponent) - fraction.length);
    if (!number.inReach()) throw refused(OUT_OF_RANGE);

    return number;
  }

  /** A result past the reach is refused, as a number written past it is. */
  private static computed(value: bigint, exponent: number): ExactNumber {
    const negative = value < 0n;
    const number = ExactNumber.normalized(negative, (negative ? -value : value).toString(), exponent);
    if (!number.inReach()) throw new NumberError(`${shown(number.toString())} ${OUT_OF_RANGE}`, OUT_OF_RANGE);

    return number;
  }

  private inReach(): boolean {
    return this.digits.length + this.exponent <= MAX_PLACES && -this.exponent <= MAX_PLACES;
  }

  private static normalized(negative: boolean, digits: string, exponent: number): ExactNumber {
    const significant = digits.replace(/^0+/, '');
    if (significant === '') return new ExactNumber(false, '0', 0);

    const trimmed = significant.replace(/0+$/, '');

    return new ExactNumber(negative, trimmed, exponent + significant.length - trimmed.length);
  }

  plus(other: ExactNumber): ExactNumber {
    const exponent = Math.min(this.exponent, other.exponent);

    return ExactNumber.computed(this.scaledTo(exponent) + other.scaledTo(exponent), exponent);
  }

  minus(other: ExactNumber): ExactNumber {
    return this.plus(other.negated());
  }

  times(other: ExactNumber): ExactNumber {
    return ExactNumber.computed(this.scaledTo(this.exponent) * other.scaledTo(other.exponent), this.exponent + other.exponent);
  }

  /** Rounded half to even, where the quotient has more digits than it keeps. */
  dividedBy(other: ExactNumber): ExactNumber {
    if (other.isZero()) throw new RangeError('A number cannot be divided by zero');
    if (this.isZero()) return this;

    // Enough digits that one more than are kept is known, to round by.
    const shift = Math.max(0, QUOTIENT_DIGITS + 1 + other.digits.length - this.digits.length);
    const dividend = BigInt(this.digits) * 10n ** BigInt(shift);
    const divisor = BigInt(other.digits);
    const dropped = (dividend / divisor).toString().length - QUOTIENT_DIGITS;
    const scale = divisor * 10n ** BigInt(dropped);
    const kept = rounded(dividend / scale, dividend % scale, scale);

    return ExactNumber.computed(this.negative === other.negative ? kept : -kept, this.exponent - other.exponent - shift + dropped);
  }

  /** Takes off whole times the divisor goes in, so the remainder has the sign of this one, and is exact. */
  remainder(other: ExactNumber): ExactNumber {
    if (other.isZero()) throw new RangeError('A number cannot be divided by zero');

    const exponent = Math.min(this.exponent, other.exponent);

    return ExactNumber.computed(this.scaledTo(exponent) % other.scaledTo(exponent), exponent);
  }

  isZero(): boolean {
    return this.digits === '0';
  }

  negated(): ExactNumber {
    return ExactNumber.normalized(!this.negative, this.digits, this.exponent);
  }

  /** The signed digits for an exponent no larger than this one's. */
  private scaledTo(exponent: number): bigint {
    const scaled = BigInt(this.digits) * 10n ** BigInt(this.exponent - exponent);

    return this.negative ? -scaled : scaled;
  }

  toString(): string {
    return (this.negative ? '-' : '') + this.unsigned();
  }

  /** `places` digits after the point, rounded half to even; a negative number that rounds to zero keeps its sign, as JavaScript does. */
  toFixed(places: number): string {
    const [whole, fraction = ''] = this.roundedAt(-places).unsigned().split('.');

    return (this.negative ? '-' : '') + (places === 0 ? whole : `${whole}.${fraction.padEnd(places, '0')}`);
  }

  /** One digit before the point and `places` after, rounded half to even, in JavaScript's form: `1.50e+3`. */
  toExponential(places: number): string {
    const kept = this.roundedAt(this.magnitude() - places);
    const digits = kept.digits.padEnd(places + 1, '0');
    const exponent = kept.magnitude();

    return `${this.negative ? '-' : ''}${digits[0]}${places === 0 ? '' : `.${digits.slice(1)}`}e${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
  }

  /** The power of ten of the first digit: 2 for 100, -1 for 0.5, and 0 for zero. */
  private magnitude(): number {
    return this.digits.length + this.exponent - 1;
  }

  /** Not checked against the reach, since only its text is written: 9.9e999 may round to 1e1000. */
  private roundedAt(exponent: number): ExactNumber {
    if (this.exponent >= exponent) return this;

    const digits = BigInt(this.digits);
    const scale = 10n ** BigInt(exponent - this.exponent);

    return ExactNumber.normalized(this.negative, rounded(digits / scale, digits % scale, scale).toString(), exponent);
  }

  private unsigned(): string {
    if (this.exponent >= 0) return this.digits + '0'.repeat(this.exponent);

    const point = this.digits.length + this.exponent;

    return point > 0 ? `${this.digits.slice(0, point)}.${this.digits.slice(point)}` : `0.${'0'.repeat(-point)}${this.digits}`;
  }

  compare(other: ExactNumber): number {
    const sign = this.sign() - other.sign();
    if (sign !== 0) return Math.sign(sign);

    return this.sign() * this.compareSize(other);
  }

  private sign(): number {
    if (this.isZero()) return 0;

    return this.negative ? -1 : 1;
  }

  /** More integer places means larger; with as many, the digits decide, since none has trailing zeros. */
  private compareSize(other: ExactNumber): number {
    const places = this.digits.length + this.exponent - (other.digits.length + other.exponent);
    if (places !== 0) return Math.sign(places);
    if (this.digits === other.digits) return 0;

    return this.digits < other.digits ? -1 : 1;
  }

  /** Throws rather than rounds; `name` labels the error. */
  toSafeInteger(name?: string): number {
    const refused = (problem: string) => new NumberError(`${name ? `${name}: ` : ''}${shown(this.toString())} ${problem}`, problem);
    if (this.exponent < 0) throw refused('is not a whole number');

    const value = Number(this.toString());
    if (!Number.isSafeInteger(value)) throw refused(`is outside the range -${Number.MAX_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`);

    return value;
  }

  /** Written as a raw JSON number, so state and plan files keep it exactly. */
  toJSON(): unknown {
    return JSON.rawJSON(this.toString());
  }

  /** Every number becomes an ExactNumber; a caller turns its own counters back into plain numbers. */
  static readJSON(text: string): unknown {
    // Read first without the reviver, which recurses where a plain parse does not.
    if (nestingOf(JSON.parse(text)) > MAX_FILE_NESTING) throw new NestingError(MAX_FILE_NESTING);

    // The reviver gets a source for every primitive, so a number always has one.
    return JSON.parse(text, (_, value, context) => (typeof value === 'number' ? ExactNumber.parse(context.source as string) : value));
  }
}

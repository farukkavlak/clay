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

    if (number.digits.length + number.exponent > MAX_PLACES || -number.exponent > MAX_PLACES)
      throw refused(`is out of range: a number reaches at most ${MAX_PLACES} places either side of the point`);

    return number;
  }

  private static normalized(negative: boolean, digits: string, exponent: number): ExactNumber {
    const significant = digits.replace(/^0+/, '');
    if (significant === '') return new ExactNumber(false, '0', 0);

    const trimmed = significant.replace(/0+$/, '');

    return new ExactNumber(negative, trimmed, exponent + significant.length - trimmed.length);
  }

  toString(): string {
    return (this.negative ? '-' : '') + this.unsigned();
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
    if (this.digits === '0') return 0;

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
    // The reviver gets a source for every primitive, so a number always has one.
    return JSON.parse(text, (_, value, context) => (typeof value === 'number' ? ExactNumber.parse(context.source as string) : value));
  }
}

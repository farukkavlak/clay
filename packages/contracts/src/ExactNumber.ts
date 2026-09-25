// Node 22.13, the engines floor, has JSON.rawJSON and hands a reviver each value's source; the es2022 lib typings have neither.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
    parse(text: string, reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown): unknown;
  }
}

/** JSON's number, with leading zeros allowed, since a configuration may write `007`. */
const NUMERAL = /^(-)?(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/;

/** Bounds the exponent, which would round past 2^53, and the length of the plain form. */
const MAX_PLACES = 1000;

/** A text or a value `ExactNumber` refuses; its own class, so a caller can catch it and let any other failure through. */
export class NumberError extends Error {
  override name = 'NumberError';
}

/** A refused text is shown back, but a number of a thousand digits is not worth reading twice. */
function shown(text: string, quote = ''): string {
  return text.length <= 40 ? `${quote}${text}${quote}` : `${quote}${text.slice(0, 20)}…${quote} (${text.length} characters)`;
}

/**
 * A number kept exactly as it was written. JavaScript's own numbers round past 2^53 and in most decimals.
 * The value is `digits × 10^exponent`, with no zero at either end of `digits`, so one number has one form and compares equal however it was written.
 */
export class ExactNumber {
  private constructor(
    private readonly negative: boolean,
    private readonly digits: string,
    private readonly exponent: number
  ) {}

  static parse(text: string): ExactNumber {
    const match = NUMERAL.exec(text);
    if (!match) throw new NumberError(`${shown(text, '"')} is not a number`);

    const [, sign, whole, fraction = '', exponent = '0'] = match;
    const number = ExactNumber.normalized(sign === '-', whole + fraction, Number(exponent) - fraction.length);

    if (number.digits.length + number.exponent > MAX_PLACES || -number.exponent > MAX_PLACES)
      throw new NumberError(`${shown(text, '"')} is out of range: a number reaches at most ${MAX_PLACES} places either side of the point`);

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

  /** For whoever needs a JavaScript number, as a provider sizing something does; refused rather than rounded. `name` says what the number is. */
  toSafeInteger(name?: string): number {
    const refused = (problem: string) => new NumberError(`${name ? `${name}: ` : ''}${shown(this.toString())} ${problem}`);
    if (this.exponent < 0) throw refused('is not a whole number');

    const value = Number(this.toString());
    if (!Number.isSafeInteger(value)) throw refused(`is outside the range -${Number.MAX_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`);

    return value;
  }

  /** Written into JSON as the number it is, so a state or a plan file keeps it exactly. */
  toJSON(): unknown {
    return JSON.rawJSON(this.toString());
  }

  /** JSON text with every number in it kept exactly; a file that holds numbers of its own turns those back itself. */
  static readJSON(text: string): unknown {
    // A number is a primitive, and a primitive always comes with its source.
    return JSON.parse(text, (_, value, context) => (typeof value === 'number' ? ExactNumber.parse(context.source as string) : value));
  }
}

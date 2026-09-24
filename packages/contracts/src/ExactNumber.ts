// Node 22.13, the engines floor, has JSON.rawJSON; the es2022 lib typings do not.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

/** JSON's number, with leading zeros allowed, since a configuration may write `007`. */
const NUMERAL = /^(-)?(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/;

/** Bounds the exponent, which would round past 2^53, and the length of the plain form. */
const MAX_PLACES = 1000;

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
    if (!match) throw new Error(`"${text}" is not a number`);

    const [, sign, whole, fraction = '', exponent = '0'] = match;
    const number = ExactNumber.normalized(sign === '-', whole + fraction, Number(exponent) - fraction.length);

    if (number.digits.length + number.exponent > MAX_PLACES || -number.exponent > MAX_PLACES)
      throw new Error(`"${text}" is out of range: a number reaches at most ${MAX_PLACES} places either side of the point`);

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

  /** For whoever needs a JavaScript number, as a provider sizing something does; refused rather than rounded. */
  toSafeInteger(): number {
    if (this.exponent < 0) throw new Error(`${this} is not a whole number`);

    const value = Number(this.toString());
    if (!Number.isSafeInteger(value)) throw new Error(`${this} is outside the range a whole number can have here, -${Number.MAX_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`);

    return value;
  }

  /** Written into JSON as the number it is, so a state or a plan file keeps it exactly. */
  toJSON(): unknown {
    return JSON.rawJSON(this.toString());
  }
}

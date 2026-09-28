import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';
import { Token, TokenType } from './tokens';

interface TokenSpec {
  type: TokenType;
  regex: RegExp;
}

/** Inside quotes the text is a string's until `${` opens an interpolation, which reads tokens until its `}`. */
interface Mode {
  kind: 'string' | 'interpolation';
  opened: Position;
}

/** Every regex is sticky: it matches at the cursor and nowhere else, so nothing slices the input. */
export class Lexer {
  private cursor: number = 0;
  private line: number = 1;
  private column: number = 1;
  private modes: Mode[] = [];

  private skip = /\s+|#[^\n]*|\/\/[^\n]*/y;

  // A backslash takes the character after it along, so `\"` does not end the string, and `$${` is text; the parser reads what they mean.
  private literal = /(?:[^"\\$]|\\[\s\S]|\$\$\{|\$(?!\{))+/y;

  // Boolean sits before Identifier, or true and false would lex as identifiers.
  private specs: TokenSpec[] = [
    { type: TokenType.Boolean, regex: /(true|false)(?![\w-])/y },
    { type: TokenType.Identifier, regex: /[A-Z_a-z][\w-]*/y },
    { type: TokenType.OQuote, regex: /"/y },
    // Looser than a number, so `1.` and `1e` come whole to the parser and are refused as what they are.
    { type: TokenType.Number, regex: /\d+(?:\.\d*)?(?:[Ee][+-]?\d*)?/y },
    // Its own token, as in HCL, so a number never swallows the minus of a subtraction.
    { type: TokenType.Minus, regex: /-/y },
    { type: TokenType.LBrace, regex: /{/y },
    { type: TokenType.RBrace, regex: /}/y },
    { type: TokenType.Dot, regex: /\./y },
    { type: TokenType.LBracket, regex: /\[/y },
    { type: TokenType.RBracket, regex: /]/y },
    { type: TokenType.Comma, regex: /,/y },
    { type: TokenType.Assign, regex: /=/y },
  ];

  constructor(
    private input: string,
    private file: string
  ) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    this.cursor = 0;
    this.line = 1;
    this.column = 1;
    this.modes = [];

    while (this.cursor < this.input.length) {
      const token = this.mode()?.kind === 'string' ? this.stringToken() : this.codeToken();
      if (token) tokens.push(token);
    }

    this.checkClosed();
    tokens.push({ type: TokenType.EOF, value: '', position: this.here() });
    return tokens;
  }

  /** Outside quotes, and inside a `${`: whitespace and comments go, and each token may open or close a mode. */
  private codeToken(): Token | undefined {
    const skipped = this.matchHere(this.skip);
    if (skipped !== undefined) {
      // Skipped, a comment would let the reference read as if it were not there.
      if (this.mode() && !/^\s/.test(skipped)) throw new ConfigError("A comment cannot sit inside '${'", this.here());

      this.advance(skipped);
      return undefined;
    }

    const token = this.nextToken();
    if (!token) throw new ConfigError(`Unexpected character: "${this.input[this.cursor]}"`, this.here());

    return this.switchMode(token);
  }

  private switchMode(token: Token): Token {
    const inside = this.mode();

    if (inside && token.type === TokenType.OQuote) throw this.neverClosed(inside);
    if (token.type === TokenType.OQuote) this.modes.push({ kind: 'string', opened: token.position });

    if (inside && token.type === TokenType.RBrace) {
      this.modes.pop();
      return { ...token, type: TokenType.TemplateEnd };
    }

    return token;
  }

  /** Inside quotes: the closing quote, a `${`, or the text up to either. */
  private stringToken(): Token {
    const position = this.here();

    if (this.input.startsWith('"', this.cursor)) {
      this.advance('"');
      this.modes.pop();
      return { type: TokenType.CQuote, value: '"', position };
    }

    if (this.input.startsWith('${', this.cursor)) {
      this.advance('${');
      this.modes.push({ kind: 'interpolation', opened: position });
      return { type: TokenType.TemplateInterp, value: '${', position };
    }

    // Only a backslash that ends the input matches nothing; it is text, and the string is then never closed.
    const text = this.matchHere(this.literal) ?? this.input.slice(this.cursor);
    this.advance(text);
    return { type: TokenType.QuotedLit, value: text, position };
  }

  /** The input ended inside quotes; the innermost thing still open is the one to name. */
  private checkClosed(): void {
    const inside = this.mode();
    if (inside) throw this.neverClosed(inside);
  }

  private neverClosed(mode: Mode): ConfigError {
    const message = mode.kind === 'string' ? 'This string is never closed' : "This '${' is never closed with '}'";
    return new ConfigError(message, mode.opened);
  }

  private mode(): Mode | undefined {
    return this.modes.at(-1);
  }

  private nextToken(): Token | undefined {
    for (const spec of this.specs) {
      const text = this.matchHere(spec.regex);
      if (text === undefined) continue;

      const token = { type: spec.type, value: text, position: this.here() };

      this.advance(text);
      return token;
    }

    return undefined;
  }

  private matchHere(regex: RegExp): string | undefined {
    regex.lastIndex = this.cursor;
    return regex.exec(this.input)?.[0];
  }

  private here(): Position {
    return { file: this.file, line: this.line, column: this.column };
  }

  private advance(text: string) {
    ({ line: this.line, column: this.column } = advanced(this.here(), text));
    this.cursor += text.length;
  }
}

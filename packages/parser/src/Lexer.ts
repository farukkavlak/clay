import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';
import { Token, TokenType } from './tokens';

interface TokenSpec {
  type: TokenType;
  regex: RegExp;
}

/**
 * Inside quotes or a heredoc the text is a string's until `${` opens an interpolation, which reads tokens until its `}`.
 * A `{` inside an interpolation opens a map, so the `}` that closes the map is not taken for the interpolation's.
 */
type Mode = { kind: 'string' | 'interpolation' | 'map'; opened: Position } | Heredoc;

/** A heredoc ends at a line holding only its name. */
interface Heredoc {
  kind: 'heredoc';
  opened: Position;
  name: string;
  closing: RegExp;
}

/** Every regex is sticky: it matches at the cursor and nowhere else, so nothing slices the input. */
export class Lexer {
  private cursor: number = 0;
  private line: number = 1;
  private column: number = 1;
  private modes: Mode[] = [];
  private input: string;

  private skip = /\s+|#[^\n]*|\/\/[^\n]*/y;

  // A backslash takes the character after it along, so `\"` does not end the string, and `$${` is text; the parser reads what they mean.
  // A line break ends the match: a quoted string is closed on its line.
  private literal = /(?:[^"\\$\n]|\\[^\n]|\$\$\{|\$(?!\{))+/y;

  // A heredoc's text is taken a line at a time, so each line can be checked for the closing name.
  private heredocText = /(?:[^\n$]|\$\$\{|\$(?!\{))*\n?/y;

  private heredoc = /<<(-?)([A-Z_a-z][\w-]*)\n/y;

  // Boolean and Null sit before Identifier, or true, false and null would lex as identifiers.
  private specs: TokenSpec[] = [
    { type: TokenType.Boolean, regex: /(true|false)(?![\w-])/y },
    { type: TokenType.Null, regex: /null(?![\w-])/y },
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
    { type: TokenType.LParen, regex: /\(/y },
    { type: TokenType.RParen, regex: /\)/y },
    { type: TokenType.Comma, regex: /,/y },
    { type: TokenType.Assign, regex: /=/y },
  ];

  // A checkout may write a line break as CRLF, and a heredoc's value must not change with it.
  constructor(
    input: string,
    private file: string
  ) {
    this.input = input.replaceAll('\r\n', '\n');
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    this.cursor = 0;
    this.line = 1;
    this.column = 1;
    this.modes = [];

    while (this.cursor < this.input.length) {
      const token = this.nextInMode(this.mode());
      if (token) tokens.push(token);
    }

    this.checkClosed();
    tokens.push({ type: TokenType.EOF, value: '', position: this.here() });
    return tokens;
  }

  private nextInMode(mode: Mode | undefined): Token | undefined {
    if (mode?.kind === 'string') return this.stringToken(mode);
    if (mode?.kind === 'heredoc') return this.heredocToken(mode);

    return this.codeToken();
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

    if (this.input.startsWith('<<', this.cursor)) return this.openHeredoc();

    const token = this.nextToken();
    if (!token) throw new ConfigError(`Unexpected character: "${this.input[this.cursor]}"`, this.here());

    return this.switchMode(token);
  }

  private switchMode(token: Token): Token {
    const inside = this.mode();

    if (token.type === TokenType.OQuote) this.modes.push({ kind: 'string', opened: token.position });
    if (inside && token.type === TokenType.LBrace) this.modes.push({ kind: 'map', opened: token.position });

    if (inside && token.type === TokenType.RBrace) {
      this.modes.pop();
      if (inside.kind === 'interpolation') return { ...token, type: TokenType.TemplateEnd };
    }

    return token;
  }

  /** Inside quotes: the closing quote, a `${`, or the text up to either. */
  private stringToken(mode: Mode): Token {
    const position = this.here();

    if (this.input.startsWith('"', this.cursor)) {
      this.advance('"');
      this.modes.pop();
      return { type: TokenType.CQuote, value: '"', position };
    }

    if (this.input.startsWith('${', this.cursor)) return this.openInterpolation(position);

    // Nothing matches at a line break, or at a backslash before one or at the end of the input.
    const text = this.matchHere(this.literal);
    if (text === undefined) throw this.neverClosed(mode);

    this.advance(text);
    return { type: TokenType.QuotedLit, value: text, position };
  }

  private openInterpolation(position: Position): Token {
    this.advance('${');
    this.modes.push({ kind: 'interpolation', opened: position });
    return { type: TokenType.TemplateInterp, value: '${', position };
  }

  /** `<<NAME` or `<<-NAME`, and the line break its text starts after. */
  private openHeredoc(): Token {
    const position = this.here();
    this.heredoc.lastIndex = this.cursor;
    const match = this.heredoc.exec(this.input);
    if (!match) throw new ConfigError('A heredoc opens with <<NAME or <<-NAME at the end of a line', position);

    const [opener, flush, name] = match;
    this.advance(opener);
    this.modes.push({ kind: 'heredoc', opened: position, name, closing: new RegExp(String.raw`[ \t]*${name}[ \t]*(?=\n|$)`, 'y') });
    return { type: TokenType.OHeredoc, value: `<<${flush}${name}`, position };
  }

  /** Inside a heredoc: at the start of a line its closing name, else a `${`, or the text up to one or to the end of the line. */
  private heredocToken(mode: Heredoc): Token {
    const position = this.here();

    const closing = this.input[this.cursor - 1] === '\n' ? this.matchHere(mode.closing) : undefined;
    if (closing !== undefined) {
      this.advance(closing);
      this.modes.pop();
      return { type: TokenType.CHeredoc, value: closing, position };
    }

    if (this.input.startsWith('${', this.cursor)) return this.openInterpolation(position);

    // Never empty: the cursor is not at the end, and a `${` was taken above.
    const text = this.matchHere(this.heredocText) as string;
    this.advance(text);
    return { type: TokenType.StringLit, value: text, position };
  }

  private checkClosed(): void {
    const innermost = this.mode();
    if (innermost) throw this.neverClosed(innermost);
  }

  /** A `}` left out opens a string at the quote meant to close, so the first open `${` is named. */
  private neverClosed(innermost: Mode): ConfigError {
    const interpolation = this.modes.find((mode) => mode.kind === 'interpolation');
    if (interpolation) {
      const message = innermost.kind === 'string' ? "This '${' is never closed with '}', or a string inside it is not closed on its line" : "This '${' is never closed with '}'";
      return new ConfigError(message, interpolation.opened);
    }

    if (innermost.kind === 'heredoc') return new ConfigError(`This heredoc is never closed with a line holding only ${innermost.name}`, innermost.opened);

    return new ConfigError(String.raw`This string is never closed on its line; write \n for a line break inside it, or use a heredoc`, innermost.opened);
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

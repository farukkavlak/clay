import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';
import { Token, TokenType } from './tokens';

interface TokenSpec {
  type: TokenType;
  regex: RegExp;
}

/** Every regex is sticky: it matches at the cursor and nowhere else, so nothing slices the input. */
export class Lexer {
  private cursor: number = 0;
  private line: number = 1;
  private column: number = 1;

  private skip = /\s+|#[^\n]*|\/\/[^\n]*/y;

  // Boolean sits before Identifier, or true and false would lex as identifiers.
  private specs: TokenSpec[] = [
    { type: TokenType.Boolean, regex: /(true|false)(?![\w-])/y },
    { type: TokenType.Identifier, regex: /[A-Z_a-z][\w-]*/y },
    { type: TokenType.String, regex: /"[^"]*"/y },
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

  /** `start` is where the input begins in its file, for a piece of a file lexed on its own. */
  constructor(
    private input: string,
    private file: string,
    private start = { line: 1, column: 1 }
  ) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    this.cursor = 0;
    this.line = this.start.line;
    this.column = this.start.column;

    while (this.cursor < this.input.length) {
      const skipped = this.matchHere(this.skip);
      if (skipped !== undefined) {
        this.advance(skipped);
        continue;
      }

      const token = this.nextToken();
      if (!token) throw new ConfigError(`Unexpected character: "${this.input[this.cursor]}"`, this.here());

      tokens.push(token);
    }

    tokens.push({ type: TokenType.EOF, value: '', position: this.here() });
    return tokens;
  }

  private nextToken(): Token | undefined {
    for (const spec of this.specs) {
      const text = this.matchHere(spec.regex);
      if (text === undefined) continue;

      const token = { type: spec.type, value: spec.type === TokenType.String ? text.slice(1, -1) : text, position: this.here() };

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

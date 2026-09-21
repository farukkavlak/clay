import { ConfigError } from './ConfigError';
import { Position } from './Position';
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
    { type: TokenType.Boolean, regex: /(true|false)\b/y },
    { type: TokenType.Identifier, regex: /[A-Z_a-z]\w*/y },
    { type: TokenType.String, regex: /"[^"]*"/y },
    { type: TokenType.Number, regex: /\d+/y },
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
    for (const char of text)
      if (char === '\n') {
        this.line++;
        this.column = 1;
      } else this.column++;
    this.cursor += text.length;
  }
}

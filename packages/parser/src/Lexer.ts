import { ConfigError } from './ConfigError';
import { Position } from './Position';
import { Token, TokenType } from './tokens';

interface TokenSpec {
  type: TokenType;
  regex: RegExp;
}

export class Lexer {
  private cursor: number = 0;
  private line: number = 1;
  private column: number = 1;

  // Boolean sits before Identifier, or true and false would lex as identifiers.
  private specs: TokenSpec[] = [
    { type: TokenType.Boolean, regex: /^(true|false)\b/ },
    { type: TokenType.Identifier, regex: /^[A-Z_a-z]\w*/ },
    { type: TokenType.String, regex: /^"[^"]*"/ },
    { type: TokenType.Number, regex: /^\d+/ },
    { type: TokenType.LBrace, regex: /^{/ },
    { type: TokenType.RBrace, regex: /^}/ },
    { type: TokenType.Dot, regex: /^\./ },
    { type: TokenType.LBracket, regex: /^\[/ },
    { type: TokenType.RBracket, regex: /^]/ },
    { type: TokenType.Comma, regex: /^,/ },
    { type: TokenType.Assign, regex: /^=/ },
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
      const remaining = this.input.slice(this.cursor);

      const whitespaceMatch = remaining.match(/^\s+/);
      if (whitespaceMatch) {
        this.advance(whitespaceMatch[0]);
        continue;
      }

      if (remaining.startsWith('#') || remaining.startsWith('//')) {
        const lineEndIndex = remaining.indexOf('\n');
        if (lineEndIndex === -1) {
          this.cursor = this.input.length;
          break;
        }
        this.advance(remaining.slice(0, lineEndIndex + 1));
        continue;
      }

      const token = this.nextToken(remaining);
      if (!token) throw new ConfigError(`Unexpected character: "${remaining[0]}"`, this.here());

      tokens.push(token);
    }

    tokens.push({ type: TokenType.EOF, value: '', position: this.here() });
    return tokens;
  }

  private nextToken(remaining: string): Token | undefined {
    for (const spec of this.specs) {
      const match = remaining.match(spec.regex);
      if (!match) continue;

      const text = match[0];
      const token = { type: spec.type, value: spec.type === TokenType.String ? text.slice(1, -1) : text, position: this.here() };

      this.advance(text);
      return token;
    }

    return undefined;
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

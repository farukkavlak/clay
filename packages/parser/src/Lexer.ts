import { Token, TokenType } from './tokens';

interface TokenSpec {
  type: TokenType;
  regex: RegExp;
}

export class Lexer {
  private input: string = '';
  private cursor: number = 0;
  private line: number = 1;
  private column: number = 1;

  // Regex rules (Order matters!)
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

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    this.cursor = 0;
    this.line = 1;
    this.column = 1;

    while (this.cursor < this.input.length) {
      const remaining = this.input.slice(this.cursor);

      // 1. Skip Whitespace
      const whitespaceMatch = remaining.match(/^\s+/);
      if (whitespaceMatch) {
        this.advance(whitespaceMatch[0]);
        continue;
      }

      // 2. Skip Comments (# or //)
      if (remaining.startsWith('#') || remaining.startsWith('//')) {
        const lineEndIndex = remaining.indexOf('\n');
        if (lineEndIndex === -1) {
          // Comment goes to end of file
          this.cursor = this.input.length;
          break;
        }
        this.advance(remaining.slice(0, lineEndIndex + 1));
        continue;
      }

      // 3. Match Token
      let matched = false;
      for (const spec of this.specs) {
        const match = remaining.match(spec.regex);
        if (match) {
          const value = match[0];

          // Special handling for String to remove quotes
          let tokenValue = value;
          if (spec.type === TokenType.String) tokenValue = value.slice(1, -1);

          tokens.push({
            type: spec.type,
            value: tokenValue,
            line: this.line,
            column: this.column,
          });

          this.advance(value);
          matched = true;
          break;
        }
      }

      if (!matched) throw new Error(`Unexpected token at line ${this.line}, column ${this.column}: "${remaining[0]}"`);
    }

    tokens.push({ type: TokenType.EOF, value: '', line: this.line, column: this.column });
    return tokens;
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

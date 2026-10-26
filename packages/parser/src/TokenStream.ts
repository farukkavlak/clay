import { MAX_NESTING } from '@clay/contracts';

import { ConfigError } from './ConfigError';
import { Position } from './Position';
import { Token, TokenType } from './tokens';

/** The tokens of one file and the place reached in them, shared by every part of the parser that reads them. */
export class TokenStream {
  private current = 0;
  /** Openings around what is being read. */
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  /** The token `offset` places past the next one. */
  ahead(offset: number): Token {
    return this.tokens[this.current + offset];
  }

  skip(count: number): void {
    this.current += count;
  }

  peek(): Token {
    return this.tokens[this.current];
  }

  previous(): Token {
    return this.tokens[this.current - 1];
  }

  advance(): Token {
    this.current++;
    return this.previous();
  }

  isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  check(type: TokenType): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  /** A contextual keyword, like `for` and `in`. */
  checkWord(word: string): boolean {
    return this.check(TokenType.Identifier) && this.peek().value === word;
  }

  matchToken(...types: TokenType[]): boolean {
    for (const type of types)
      if (this.check(type)) {
        this.advance();
        return true;
      }
    return false;
  }

  consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    return this.error(message);
  }

  error(message: string): never {
    throw new ConfigError(message, this.peek().position);
  }

  plainText(quote: Token, what: string): Token {
    const text = this.matchToken(TokenType.QuotedLit) ? this.previous() : { type: TokenType.QuotedLit, value: '', position: this.peek().position };
    if (this.check(TokenType.TemplateInterp)) throw new ConfigError(`A ${what} is plain text; it cannot hold an interpolation`, quote.position);

    this.advance();
    return text;
  }

  enter(opening: Position): void {
    if (this.depth === MAX_NESTING) throw new ConfigError(`Nested more than ${MAX_NESTING} levels deep`, opening);

    this.depth++;
  }

  /** Counts the opening toward the nesting limit while `read` reads what it opens. */
  nested<T>(opening: Position, read: () => T): T {
    return this.keepingDepth(() => {
      this.enter(opening);
      return read();
    });
  }

  /** Undoes every `enter` made inside `read`, even when it throws. */
  keepingDepth<T>(read: () => T): T {
    const outer = this.depth;
    try {
      return read();
    } finally {
      this.depth = outer;
    }
  }
}

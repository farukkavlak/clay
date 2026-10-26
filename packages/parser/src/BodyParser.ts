import { Attribute, Block, Body, Header, Inside, Label, Schema } from './body';
import { ExpressionParser } from './ExpressionParser';
import { Token, TokenType } from './tokens';
import { TokenStream } from './TokenStream';

/** Reads attributes and blocks as written, `name = value` and `name "label" { ... }`, knowing nothing of what each block means. */
export class BodyParser {
  constructor(
    private readonly stream: TokenStream,
    private readonly expressions: ExpressionParser,
    private readonly schema: Schema
  ) {}

  /** The blocks of a file, each as soon as its body closes, so it can be read for what it means before the next one is. */
  *blocks(): Generator<Block> {
    while (!this.stream.isAtEnd()) {
      if (!this.stream.check(TokenType.Identifier)) this.stream.error(`Unexpected token: ${this.stream.peek().value}`);

      const header = this.parseHeader(this.stream.advance());
      this.schema.header(header, this.stream.check(TokenType.LBrace));
      // The schema refuses a header with no `{` after it.
      this.stream.advance();
      yield { type: 'Block', ...header, body: this.parseBody(header, true) };
    }
  }

  private parseHeader(name: Token): Header {
    const labels: Label[] = [];
    while (this.stream.check(TokenType.OQuote)) {
      const quote = this.stream.advance();
      labels.push({ value: this.stream.plainText(quote, 'label').value, position: quote.position });
    }

    return { name: name.value, labels, position: name.position, open: this.stream.peek().position };
  }

  private parseBody(within: Header, inFile: boolean): Body {
    const body: Body = [];
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd())
      body.push(this.parseItem(this.stream.consume(TokenType.Identifier, 'Expect attribute name.'), { block: within, before: body }));

    this.stream.consume(TokenType.RBrace, `Expect '}' after ${inFile ? 'block' : within.name} body.`);
    return body;
  }

  private parseItem(name: Token, inside: Inside): Attribute | Block {
    if (this.stream.matchToken(TokenType.Assign)) {
      const attribute: Attribute = { type: 'Attribute', name: name.value, value: this.expressions.parseValue(), position: name.position };
      this.schema.attribute(attribute, inside);
      return attribute;
    }

    const after = this.stream.peek();
    const header = this.parseHeader(name);
    if (!this.stream.matchToken(TokenType.LBrace)) return this.stream.errorAt("Expect '=' after attribute name.", after);

    this.schema.header(header, true, inside);
    const block: Block = { type: 'Block', ...header, body: this.parseBody(header, false) };
    this.schema.closed(block, inside);
    return block;
  }
}

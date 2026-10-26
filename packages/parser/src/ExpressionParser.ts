import { ExactNumber, NumberError, RESERVED_TYPES } from '@clay/contracts';

import { AttributeValue, BinaryOperator, BoundNode, CallNode, ForNode, ReferenceNode, spellIndex, TemplatePart } from './ast';
import { checkKey } from './checkKey';
import { ConfigError } from './ConfigError';
import { readEscapes } from './escapes';
import { flushed } from './heredoc';
import { Position } from './Position';
import { Step } from './reference';
import { Token, TokenType } from './tokens';
import { TokenStream } from './TokenStream';

/** Loosest first; within a level, operators group from the left. */
const BINARY_LEVELS: ReadonlyMap<TokenType, BinaryOperator>[] = [
  new Map([[TokenType.Or, '||']]),
  new Map([[TokenType.And, '&&']]),
  new Map([
    [TokenType.Equal, '=='],
    [TokenType.NotEqual, '!='],
  ]),
  new Map([
    [TokenType.Less, '<'],
    [TokenType.LessEqual, '<='],
    [TokenType.Greater, '>'],
    [TokenType.GreaterEqual, '>='],
  ]),
  new Map([
    [TokenType.Plus, '+'],
    [TokenType.Minus, '-'],
  ]),
  new Map([
    [TokenType.Star, '*'],
    [TokenType.Slash, '/'],
    [TokenType.Percent, '%'],
  ]),
];

/** Each operator token with the level it binds at. */
const OPERATORS = new Map(BINARY_LEVELS.flatMap((operators, level) => [...operators].map(([type, operator]) => [type, { level, operator }] as const)));

const CLOSING = { [TokenType.RBracket]: ']', [TokenType.RBrace]: '}' };

/** Reads a value: a literal, a reference, a call, an operation, a string, a list, a map or a for. */
export class ExpressionParser {
  /** Names bound by enclosing for expressions, innermost last. */
  private bound: string[] = [];
  private readonly named: Token[] = [];
  /** The first token of the call argument being read. */
  private argumentStart: Token | undefined;

  constructor(private readonly stream: TokenStream) {}

  /** Every name a for in the file gave an item, checked against resource types once every file of the module is read. */
  get forNames(): readonly Token[] {
    return this.named;
  }

  /** `a ? b : c` binds loosest, and either result may be a conditional too. */
  parseValue(): AttributeValue {
    const condition = this.parseBinary(0);
    if (!this.stream.matchToken(TokenType.Question)) return condition;

    return this.stream.nested(this.stream.previous().position, () => {
      const whenTrue = this.parseValue();
      this.stream.consume(TokenType.Colon, "Expect ':' after the value a conditional gives when true.");

      return { type: 'Conditional', condition, whenTrue, whenFalse: this.parseValue(), position: condition.position };
    });
  }

  /** One call climbs every operator level, since the stack a nesting level takes is what the limit guards. Each operator counts toward it. */
  private parseBinary(loosest: number): AttributeValue {
    const start = this.stream.nesting;
    try {
      let left = this.parseUnary();
      let chain: number | undefined;
      for (let next = OPERATORS.get(this.stream.peek().type); next && next.level >= loosest; next = OPERATORS.get(this.stream.peek().type)) {
        // A looser operator ends the tighter chain before it.
        if (chain !== undefined && next.level < chain) this.stream.backTo(start);
        chain = next.level;

        const operatorPosition = this.stream.advance().position;
        this.stream.enter(operatorPosition);
        left = { type: 'Binary', operator: next.operator, operatorPosition, left, right: this.parseBinary(next.level + 1), position: left.position };
      }

      return left;
    } finally {
      this.stream.backTo(start);
    }
  }

  private parseUnary(): AttributeValue {
    const { position } = this.stream.peek();
    if (this.stream.matchToken(TokenType.Bang)) return this.stream.nested(position, () => ({ type: 'Not', value: this.parseUnary(), position }));
    if (this.stream.matchToken(TokenType.Minus)) return this.parseNegative(position);

    return this.parsePrimary();
  }

  private parsePrimary(): AttributeValue {
    const { position } = this.stream.peek();
    const value = this.parseTerm();
    const path = this.parseSteps();

    return this.splatted(path.length === 0 ? value : { type: 'Index', value, path, position });
  }

  /** `[*]` reads every step after it, a `[*]` among them, into each item; parentheses end it. */
  private splatted(collection: AttributeValue): AttributeValue {
    if (!this.atSplat()) return collection;
    this.stream.skip(3);

    const { position } = collection;
    const valueName = `${spellIndex(collection)}[*]`;
    const body = this.splatted({ type: 'Bound', value: [{ name: valueName }, ...this.parseSteps()], position });
    return { type: 'For', valueName, collection, body, splat: true, position };
  }

  atSplat(): boolean {
    return this.stream.check(TokenType.LBracket) && this.stream.ahead(1).type === TokenType.Star && this.stream.ahead(2).type === TokenType.RBracket;
  }

  private parseTerm(): AttributeValue {
    const opening = this.stream.peek();
    const { position } = opening;

    if (this.stream.matchToken(TokenType.OQuote)) return this.parseString(position);
    if (this.stream.matchToken(TokenType.OHeredoc)) return this.parseHeredoc(position);

    if (this.stream.matchToken(TokenType.LBracket)) return this.collection(opening, () => this.parseList(position));
    if (this.stream.matchToken(TokenType.LBrace)) return this.collection(opening, () => this.parseMap(position));
    if (this.stream.matchToken(TokenType.LParen)) return this.stream.nested(position, () => this.parseParenthesized());

    if (this.stream.check(TokenType.Identifier)) return this.parseNamed(position);

    return this.parseLiteral(position);
  }

  private parseLiteral(position: Position): AttributeValue {
    if (this.stream.matchToken(TokenType.Number)) return { type: 'Number', value: this.exactNumber(this.stream.previous().value, position), position };
    if (this.stream.matchToken(TokenType.Boolean)) return { type: 'Boolean', value: this.stream.previous().value === 'true', position };
    if (this.stream.matchToken(TokenType.Null)) return { type: 'Null', position };

    return this.stream.error(`Unexpected value: ${this.stream.peek().value}`);
  }

  private parseParenthesized(): AttributeValue {
    const value = this.parseValue();
    this.stream.consume(TokenType.RParen, "Expect ')' after the value in parentheses.");

    return value;
  }

  /** `-` before a number is part of it, so `-1e5000` is refused as written. */
  private parseNegative(position: Position): AttributeValue {
    if (!this.stream.matchToken(TokenType.Number)) return this.stream.nested(position, () => ({ type: 'Negate', value: this.parseUnary(), position }));

    return { type: 'Number', value: this.exactNumber(`-${this.stream.previous().value}`, position), position };
  }

  private parseString(position: Position): AttributeValue {
    const parts: TemplatePart[] = [];

    while (!this.stream.matchToken(TokenType.CQuote))
      if (this.stream.matchToken(TokenType.QuotedLit)) parts.push(readEscapes(this.stream.previous().value, this.stream.previous().position));
      else parts.push(this.parseInterpolation());

    return this.template(parts, position);
  }

  /** Escapes are not decoded, except `$${`. */
  private parseHeredoc(position: Position): AttributeValue {
    const flush = this.stream.previous().value.startsWith('<<-');
    const parts: TemplatePart[] = [];

    while (!this.stream.matchToken(TokenType.CHeredoc))
      if (this.stream.matchToken(TokenType.StringLit)) parts.push(this.stream.previous().value);
      else parts.push(this.parseInterpolation());

    const text = (flush ? flushed(parts) : parts).map((part) => (typeof part === 'string' ? part.split('$${').join('${') : part));
    return this.template(text, position);
  }

  /** Merges adjacent text; a template with no interpolation becomes a `String`. */
  private template(parts: TemplatePart[], position: Position): AttributeValue {
    const joined: TemplatePart[] = [];

    for (const part of parts) {
      const last = joined.at(-1);
      if (typeof part === 'string' && typeof last === 'string') joined[joined.length - 1] = last + part;
      else if (part !== '') joined.push(part);
    }

    if (joined.every((part) => typeof part === 'string')) return { type: 'String', value: joined.join(''), position };

    return { type: 'Template', value: joined, position };
  }

  /** A string inside may hold an interpolation of its own, so each counts toward the nesting limit. */
  private parseInterpolation(): AttributeValue {
    const opening = this.stream.advance().position;
    if (this.stream.check(TokenType.TemplateEnd)) return this.stream.error("Expect a value inside '${'.");

    return this.stream.nested(opening, () => {
      const value = this.parseValue();
      this.stream.consume(TokenType.TemplateEnd, "Expect '}' after the value inside '${'.");

      return value;
    });
  }

  private parseList(position: Position): AttributeValue {
    // `for.x` is a reference to a resource of type `for`.
    if (this.stream.checkWord('for') && this.stream.ahead(1).type !== TokenType.Dot) return this.parseFor(position, TokenType.RBracket);

    const values: AttributeValue[] = [];
    while (!this.stream.check(TokenType.RBracket) && !this.stream.isAtEnd()) {
      values.push(this.parseValue());
      if (!this.stream.matchToken(TokenType.Comma)) break;
    }
    this.stream.consume(TokenType.RBracket, "Expect ']' after list.");
    return { type: 'List', value: values, position };
  }

  /** The names are bound in the key and the body only. */
  private parseFor(position: Position, closing: keyof typeof CLOSING): ForNode {
    this.stream.advance();
    const names = this.parseForNames();
    if (!this.stream.checkWord('in')) return this.stream.error("Expect 'in' after the names in a for expression.");
    this.stream.advance();

    const collection = this.parseValue();
    this.stream.consume(TokenType.Colon, "Expect ':' after the collection in a for expression.");

    this.bound.push(...names.map((name) => name.value));
    const made = { ...(closing === TokenType.RBrace ? this.parseEntry() : { body: this.parseValue() }), ...this.parseForCondition() };
    this.bound.splice(-names.length);

    this.stream.consume(closing, `Expect '${CLOSING[closing]}' after the for expression.`);
    const [keyName, valueName] = names.length === 2 ? names.map((name) => name.value) : [undefined, names[0].value];
    return { type: 'For', ...(keyName && { keyName }), valueName, collection, ...made, position };
  }

  private parseEntry(): Pick<ForNode, 'key' | 'body' | 'grouped'> {
    const key = this.parseValue();
    this.stream.consume(TokenType.FatArrow, "Expect '=>' after the key in a for expression.");
    const body = this.parseValue();

    return { key, body, ...(this.stream.matchToken(TokenType.Ellipsis) && { grouped: true }) };
  }

  private parseForCondition(): Pick<ForNode, 'condition'> {
    if (!this.stream.checkWord('if')) return {};

    this.stream.advance();
    return { condition: this.parseValue() };
  }

  private parseForNames(): Token[] {
    const names = [this.forName("Expect a name after 'for'.")];
    if (!this.stream.matchToken(TokenType.Comma)) return names;

    const second = this.forName("Expect a name after ','.");
    if (second.value === names[0].value) throw new ConfigError('The key and the value of a for need names of their own', second.position);

    return [...names, second];
  }

  /** A for name shadows references that start with it, so it cannot be a reference prefix. */
  private forName(message: string): Token {
    const name = this.stream.consume(TokenType.Identifier, message);
    if (RESERVED_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" cannot name an item in a for: a reference reads "${name.value}." as something else`, name.position);
    if (this.bound.includes(name.value)) throw new ConfigError(`"${name.value}" is named by a for around this one already`, name.position);

    this.named.push(name);
    return name;
  }

  private parseMap(position: Position): AttributeValue {
    // `{ for = 1 }` is a map with a key named `for`.
    if (this.stream.checkWord('for') && this.stream.ahead(1).type !== TokenType.Assign) return this.parseFor(position, TokenType.RBrace);

    const map: Record<string, AttributeValue> = {};
    const quoted: Record<string, Position> = {};
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const inQuotes = this.stream.matchToken(TokenType.OQuote);
      const key = inQuotes ? this.stringKey(this.stream.previous()) : this.stream.consume(TokenType.Identifier, 'Expect key in map.');
      checkKey(map, key);
      if (inQuotes) quoted[key.value] = key.position;

      this.stream.consume(TokenType.Assign, "Expect '=' after key in map.");
      map[key.value] = this.parseValue();
      this.stream.matchToken(TokenType.Comma);
    }
    this.stream.consume(TokenType.RBrace, "Expect '}' after map.");
    return { type: 'Map', value: map, ...(Object.keys(quoted).length > 0 && { quoted }), position };
  }

  /** Escapes are decoded, so one key spelled two ways is still one key. */
  private stringKey(quote: Token): Token {
    const text = this.stream.plainText(quote, 'map key');

    return { ...quote, value: readEscapes(text.value, text.position) };
  }

  private parseNamed(position: Position): ReferenceNode | CallNode | BoundNode {
    const name = this.stream.advance().value;
    if (this.stream.matchToken(TokenType.LParen)) return { type: 'Call', name, args: this.stream.nested(position, () => this.parseArguments()), position };
    if (this.bound.includes(name)) return { type: 'Bound', value: [{ name }, ...this.parseSteps()], position };

    return { type: 'Reference', value: [{ name }, ...this.parseSteps()], position };
  }

  /** A list or a map that opens a call's argument shares the call's level, so `tolist([...])` counts once. */
  private collection(opening: Token, read: () => AttributeValue): AttributeValue {
    return opening === this.argumentStart ? read() : this.stream.nested(opening.position, read);
  }

  private parseArguments(): AttributeValue[] {
    const args: AttributeValue[] = [];
    while (!this.stream.check(TokenType.RParen) && !this.stream.isAtEnd()) {
      this.argumentStart = this.stream.peek();
      args.push(this.parseValue());
      if (!this.stream.matchToken(TokenType.Comma)) break;
    }
    this.stream.consume(TokenType.RParen, "Expect ')' after the arguments.");
    return args;
  }

  parseSteps(): Step[] {
    const steps: Step[] = [];

    while (!this.atSplat() && this.stream.matchToken(TokenType.Dot, TokenType.LBracket))
      steps.push(
        this.stream.previous().type === TokenType.Dot ? { name: this.stream.consume(TokenType.Identifier, 'Expect property name after dot.').value } : this.parseBracket()
      );

    return steps;
  }

  /** A number or a string written alone is a key; any other value is read where the step is: `var.names[count.index + 1]`. */
  private parseBracket(): Step {
    const opening = this.stream.previous().position;
    if (this.stream.check(TokenType.RBracket)) return this.stream.error("Expect a value inside '['.");

    const index = this.stream.nested(opening, () => this.parseValue());
    this.stream.consume(TokenType.RBracket, "Expect ']' after the index.");

    if (index.type === 'String') return { key: index.value };
    if (index.type === 'Number') return { key: this.index(index.value, index.position) };

    return { index, spelled: spellIndex(index) };
  }

  private index(number: ExactNumber, position: Position): number {
    const written = number.toString();
    if (!/^\d+$/.test(written) || !Number.isSafeInteger(Number(written))) throw new ConfigError(`An index is a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`, position);

    return Number(written);
  }

  /** Refused at its position, as a configuration error. */
  private exactNumber(text: string, position: Position): ExactNumber {
    try {
      return ExactNumber.parse(text);
    } catch (error) {
      if (error instanceof NumberError) throw new ConfigError(error.message, position, {}, { cause: error });

      throw error;
    }
  }
}

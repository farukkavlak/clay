import { ExactNumber, NumberError } from '@clay/contracts';
import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, Program, ReferenceNode, ResourceBlock, spell, Statement, TemplatePart, VariableBlock } from './ast';
import { ConfigError } from './ConfigError';
import { readEscapes } from './escapes';
import { flushed } from './heredoc';
import { Position } from './Position';
import { NAME, Step } from './reference';
import { Token, TokenType } from './tokens';

/** Words a reference already spells: `var.x`, `data.t.n`, `module.m`. */
const RESERVED_TYPES = new Set(['module', 'var', 'data']);

export class Parser {
  private tokens: Token[];
  private current: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public parse(): Program {
    const program: Program = [];
    const declared = new Set<string>();

    while (!this.isAtEnd()) {
      const start = this.peek();
      const statement = this.parseStatement();

      // A second block with the same name would replace the first in silence.
      const label = spell(statement);
      if (declared.has(label)) throw new ConfigError(`${label} is declared twice`, start.position);
      declared.add(label);

      program.push(statement);
    }

    return program;
  }

  // No keywords: a kind is only special at the start of a statement.
  private blockParsers = new Map<string, (position: Position) => Statement>([
    ['resource', this.parseResource.bind(this)],
    ['variable', this.parseVariable.bind(this)],
    ['data', this.parseData.bind(this)],
    ['output', this.parseOutput.bind(this)],
    ['module', this.parseModule.bind(this)],
  ]);

  private parseStatement(): Statement {
    const parseBlock = this.check(TokenType.Identifier) ? this.blockParsers.get(this.peek().value) : undefined;
    if (!parseBlock) return this.error(`Unexpected token: ${this.peek().value}`);

    return parseBlock(this.advance().position);
  }

  private parseResource(position: Position): ResourceBlock {
    const typeToken = this.consumeType("Expect resource type string after 'resource'.");
    const nameToken = this.consumeName('Expect resource name string after resource type.');

    const attributes = this.parseAttributes('resource');

    return {
      type: 'Resource',
      resourceType: typeToken.value,
      name: nameToken.value,
      attributes,
      position,
    };
  }

  private parseData(position: Position): DataBlock {
    const typeToken = this.consumeType("Expect data source type string after 'data'.");
    const nameToken = this.consumeName('Expect data source name string after data source type.');

    const attributes = this.parseAttributes('data source');

    return {
      type: 'Data',
      dataSourceType: typeToken.value,
      name: nameToken.value,
      attributes,
      position,
    };
  }

  private parseVariable(position: Position): VariableBlock {
    const nameToken = this.consumeName("Expect variable name string after 'variable'.");
    if (nameToken.value === 'source') throw new ConfigError('"source" cannot be a variable name: a module call reads it as the module\'s path.', nameToken.position);

    const attributes = this.parseAttributes('variable');

    // `default` is the whole of what a variable is read for, so another name would be parsed and never read.
    for (const [key, value] of Object.entries(attributes))
      if (key !== 'default') throw new ConfigError(`Variable "${nameToken.value}" takes only "default", not "${key}".`, value.position);

    return {
      type: 'Variable',
      name: nameToken.value,
      attributes,
      position,
    };
  }

  private parseOutput(position: Position): OutputBlock {
    const nameToken = this.consumeName("Expect output name string after 'output'.");

    this.consume(TokenType.LBrace, "Expect '{' after output name.");
    if (!this.check(TokenType.Identifier) || this.peek().value !== 'value') return this.error("Expect 'value' in output block.");
    this.advance();
    this.consume(TokenType.Assign, "Expect '=' after 'value'.");

    const value = this.parseValue();

    this.consume(TokenType.RBrace, "Expect '}' after output block.");

    return {
      type: 'Output',
      name: nameToken.value,
      value,
      position,
    };
  }

  private parseModule(position: Position): ModuleBlock {
    const nameToken = this.consumeName("Expect module name string after 'module'.");

    const attributes = this.parseAttributes('module');

    return {
      type: 'Module',
      name: nameToken.value,
      attributes,
      position,
    };
  }

  /** The `{ name = value ... }` body every block but output has. */
  private parseAttributes(block: string): Record<string, AttributeValue> {
    this.consume(TokenType.LBrace, `Expect '{' after ${block} name.`);

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.');
      this.checkKey(attributes, key);
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      attributes[key.value] = this.parseValue();
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");
    return attributes;
  }

  private parseValue(): AttributeValue {
    const position = this.peek().position;

    if (this.matchToken(TokenType.OQuote)) return this.parseString(position);
    if (this.matchToken(TokenType.OHeredoc)) return this.parseHeredoc(position);
    if (this.matchToken(TokenType.Number)) return { type: 'Number', value: this.exactNumber(this.previous().value, position), position };
    if (this.matchToken(TokenType.Minus)) return this.parseNegative(position);
    if (this.matchToken(TokenType.Boolean)) return { type: 'Boolean', value: this.previous().value === 'true', position };

    if (this.matchToken(TokenType.LBracket)) return this.parseList(position);
    if (this.matchToken(TokenType.LBrace)) return this.parseMap(position);

    if (this.check(TokenType.Identifier)) return this.parseReference(position);

    return this.error(`Unexpected value: ${this.peek().value}`);
  }

  private parseNegative(position: Position): AttributeValue {
    const number = this.consume(TokenType.Number, "Expect a number after '-'.");

    return { type: 'Number', value: this.exactNumber(`-${number.value}`, position), position };
  }

  /** A string with `${ … }` in it is a template: its text, and the references read into it, each where it was written. */
  private parseString(position: Position): AttributeValue {
    const parts: TemplatePart[] = [];

    while (!this.matchToken(TokenType.CQuote))
      if (this.matchToken(TokenType.QuotedLit)) parts.push(readEscapes(this.previous().value, this.previous().position));
      else parts.push(this.parseInterpolation());

    return this.template(parts, position);
  }

  /** A heredoc's text is read as written but for `$${`; `<<-` takes off the indent its lines share. */
  private parseHeredoc(position: Position): AttributeValue {
    const flush = this.previous().value.startsWith('<<-');
    const parts: TemplatePart[] = [];

    while (!this.matchToken(TokenType.CHeredoc))
      if (this.matchToken(TokenType.StringLit)) parts.push(this.previous().value);
      else parts.push(this.parseInterpolation());

    const text = (flush ? flushed(parts) : parts).map((part) => (typeof part === 'string' ? part.split('$${').join('${') : part));
    return this.template(text, position);
  }

  /** Text next to text is one piece, and a string with no reference in it is a `String`. */
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

  /** What one `${ … }` holds: a reference and nothing else. The lexer has put `${` next. */
  private parseInterpolation(): ReferenceNode {
    this.advance();
    if (!this.check(TokenType.Identifier)) return this.error("Expect a reference inside '${'.");

    const reference = this.parseReference(this.peek().position);
    this.consume(TokenType.TemplateEnd, "Expect '}' after the reference.");

    return reference;
  }

  /** The text of a string that has no `${ … }` in it, as written; `quote` is the one that opened it. The lexer puts `"` after it. */
  private plainText(quote: Token, what: string): Token {
    const text = this.matchToken(TokenType.QuotedLit) ? this.previous() : { type: TokenType.QuotedLit, value: '', position: this.peek().position };
    if (this.check(TokenType.TemplateInterp)) throw new ConfigError(`A ${what} is plain text; it cannot hold an interpolation`, quote.position);

    this.advance();
    return text;
  }

  private parseList(position: Position): AttributeValue {
    const values: AttributeValue[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      values.push(this.parseValue());
      if (!this.matchToken(TokenType.Comma)) break;
    }
    this.consume(TokenType.RBracket, "Expect ']' after list.");
    return { type: 'List', value: values, position };
  }

  private parseMap(position: Position): AttributeValue {
    const map: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.matchToken(TokenType.OQuote) ? this.stringKey(this.previous()) : this.consume(TokenType.Identifier, 'Expect key in map.');
      this.checkKey(map, key);

      this.consume(TokenType.Assign, "Expect '=' after key in map.");
      map[key.value] = this.parseValue();
      this.matchToken(TokenType.Comma);
    }
    this.consume(TokenType.RBrace, "Expect '}' after map.");
    return { type: 'Map', value: map, position };
  }

  /** A quoted key is the text its escapes stand for, so one key spelled two ways is still one key. */
  private stringKey(quote: Token): Token {
    const text = this.plainText(quote, 'map key');

    return { ...quote, value: readEscapes(text.value, text.position) };
  }

  // A second value under one name would replace the first in silence, and `__proto__` would set a prototype, not a key.
  private checkKey(entries: Record<string, AttributeValue>, key: Token): void {
    if (key.value === '__proto__') throw new ConfigError('__proto__ cannot be a name', key.position);
    if (Object.hasOwn(entries, key.value)) throw new ConfigError(`${key.value} is set twice`, key.position);
  }

  private parseReference(position: Position): ReferenceNode {
    const parts: Step[] = [this.advance().value];

    while (this.matchToken(TokenType.Dot, TokenType.LBracket))
      parts.push(this.previous().type === TokenType.Dot ? this.consume(TokenType.Identifier, 'Expect property name after dot.').value : this.parseBracket());

    return { type: 'Reference', value: parts, position };
  }

  /** What follows a `[`: an index into a list, or a key, which reads its escapes as a map key does. */
  private parseBracket(): Step {
    let step: Step;

    if (this.matchToken(TokenType.OQuote)) step = this.stringKey(this.previous()).value;
    else if (this.check(TokenType.Number) || this.check(TokenType.Minus)) step = this.index(this.advance());
    else return this.error("Expect a number or a string inside '['.");

    this.consume(TokenType.RBracket, "Expect ']' after the index.");
    return step;
  }

  /** A place in a list is counted, so it is written in digits and fits a JavaScript number. */
  private index(token: Token): number {
    const index = Number(token.value);
    if (!/^\d+$/.test(token.value) || !Number.isSafeInteger(index))
      throw new ConfigError(`An index is a whole number from 0 to ${Number.MAX_SAFE_INTEGER}, written in digits`, token.position);

    return index;
  }

  private matchToken(...types: TokenType[]): boolean {
    for (const type of types)
      if (this.check(type)) {
        this.advance();
        return true;
      }
    return false;
  }

  /** A name travels into an address, which reads "." as a separator, so a name is an identifier, as a reference to it has to be. */
  private consumeName(message: string, word: 'name' | 'type' = 'name'): Token {
    const quote = this.consume(TokenType.OQuote, message);
    const token = { ...quote, value: this.plainText(quote, 'label').value };
    if (!NAME.test(token.value) || token.value === 'true' || token.value === 'false')
      throw new ConfigError(`Invalid ${word} "${token.value}": a ${word} starts with a letter or underscore, then letters, digits, underscores and dashes.`, token.position);

    return token;
  }

  /** A type shares the name rule, and cannot be a word a reference already spells. */
  private consumeType(message: string): Token {
    const token = this.consumeName(message, 'type');
    if (RESERVED_TYPES.has(token.value)) throw new ConfigError(`"${token.value}" cannot be a type: a reference reads "${token.value}." as something else.`, token.position);

    return token;
  }

  /** A literal that is no number, or past what one can hold, is the configuration's mistake, so it is refused where it was written. */
  private exactNumber(text: string, position: Position): ExactNumber {
    try {
      return ExactNumber.parse(text);
    } catch (error) {
      if (error instanceof NumberError) throw new ConfigError(error.message, position, {}, { cause: error });

      throw error;
    }
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    return this.error(message);
  }

  private error(message: string): never {
    throw new ConfigError(message, this.peek().position);
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private advance(): Token {
    this.current++;
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }
}

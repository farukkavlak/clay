import { ExactNumber, NumberError, Type, types } from '@clay/contracts';
import {
  AttributeValue,
  BoundNode,
  CallNode,
  DataBlock,
  ForNode,
  ModuleBlock,
  namedIn,
  OutputBlock,
  Program,
  ReferenceNode,
  ResourceBlock,
  spell,
  spellNamed,
  Statement,
  TemplatePart,
  VariableBlock,
} from './ast';
import { ConfigError } from './ConfigError';
import { readEscapes } from './escapes';
import { flushed } from './heredoc';
import { Position } from './Position';
import { NAME, Step } from './reference';
import { Token, TokenType } from './tokens';

/** Words a reference already spells: `var.x`, `data.t.n`, `module.m`, `count.index`, `each.key`, `path.module`. */
const RESERVED_TYPES = new Set(['module', 'var', 'data', 'count', 'each', 'path']);

/** Words that lex as values, so a name spelled like one could never be read back by a reference. */
const KEYWORDS = new Set(['true', 'false', 'null']);

/** The bracket that closes a for, by the token for it. */
const CLOSING = { [TokenType.RBracket]: ']', [TokenType.RBrace]: '}' };

/** The types a variable names by a word alone; `any` takes a value as it is. */
const PRIMITIVE_TYPES = new Map<string, Type>([
  ['string', types.string],
  ['number', types.number],
  ['bool', types.bool],
  ['any', types.dynamic],
]);

/** The types written with the types they hold in parentheses after the name. */
const HOLDING_TYPES = new Set(['list', 'set', 'map', 'tuple', 'object']);

/** What makes a block many instances; a module call keeps these for itself, so they name no module input. */
const INSTANCE_ARGUMENTS = ['count', 'for_each'];

export class Parser {
  private tokens: Token[];
  private current: number = 0;
  /** The names the for expressions around the value being read give, innermost last. */
  private bound: string[] = [];
  /** Every name a for gives, checked against the resource types once every block is read. */
  private forNames: Token[] = [];

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

    this.checkForNames(program);
    return program;
  }

  /** In a for's body its names come first, so one spelled as a resource type would hide every reference to that type. */
  private checkForNames(program: Program): void {
    const types = new Set(program.flatMap((statement) => (statement.type === 'Resource' ? [statement.resourceType] : [])));
    const shadowing = this.forNames.find((name) => types.has(name.value));
    if (shadowing)
      throw new ConfigError(`"${shadowing.value}" cannot name an item in a for: a reference reads "${shadowing.value}." as a resource of that type`, shadowing.position);
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

    const { count, for_each: forEach, ...attributes } = this.parseAttributes('resource');
    if (count && forEach) throw new ConfigError(`resource "${typeToken.value}" "${nameToken.value}" has count or for_each, not both`, forEach.position);

    return {
      type: 'Resource',
      resourceType: typeToken.value,
      name: nameToken.value,
      ...(count && { count }),
      ...(forEach && { forEach }),
      attributes,
      position,
    };
  }

  private parseData(position: Position): DataBlock {
    const typeToken = this.consumeType("Expect data source type string after 'data'.");
    const nameToken = this.consumeName('Expect data source name string after data source type.');

    const attributes = this.parseAttributes('data source');
    this.refuseInstances(attributes, `data "${typeToken.value}" "${nameToken.value}"`);

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
    if (INSTANCE_ARGUMENTS.includes(nameToken.value))
      throw new ConfigError(`"${nameToken.value}" cannot be a variable name: a module call keeps it for itself.`, nameToken.position);

    const { attributes, valueType } = this.parseVariableBody(nameToken.value);

    // A module call's input replaces the default, so a reference or a call in it would never be checked.
    const [named] = attributes.default ? namedIn(attributes.default) : [];
    if (named) throw new ConfigError(`A variable's default is a constant, so it cannot hold ${spellNamed(named)}`, named.position);

    return {
      type: 'Variable',
      name: nameToken.value,
      attributes,
      ...(valueType && { valueType }),
      position,
    };
  }

  /** `default` and `type` are the whole of what a variable is read for, so another name would be parsed and never read. */
  private parseVariableBody(name: string): Pick<VariableBlock, 'attributes' | 'valueType'> {
    this.consume(TokenType.LBrace, "Expect '{' after variable name.");

    const attributes: Record<string, AttributeValue> = {};
    let valueType: Type | undefined;
    const seen: Record<string, true> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.');
      this.checkKey(seen, key);
      seen[key.value] = true;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");

      if (key.value === 'type') {
        valueType = this.parseType();
        continue;
      }

      const value = this.parseValue();
      if (key.value !== 'default') throw new ConfigError(`Variable "${name}" takes only "default" and "type", not "${key.value}".`, value.position);
      attributes.default = value;
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");
    return { attributes, valueType };
  }

  private parseType(): Type {
    if (this.check(TokenType.OQuote)) return this.error('A type is written without quotes: string, not "string"');
    const name = this.consume(TokenType.Identifier, 'Expect a type: string, number, bool, any, list(...), set(...), map(...), tuple([...]) or object({...}).');

    const primitive = PRIMITIVE_TYPES.get(name.value);
    if (primitive && this.check(TokenType.LParen)) throw new ConfigError(`${name.value} holds no other type, so it takes no '('`, this.peek().position);
    if (primitive) return primitive;
    if (!HOLDING_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" is not a type: a type is string, number, bool, any, list, set, map, tuple or object`, name.position);

    this.consume(TokenType.LParen, `Expect '(' after ${name.value}.`);
    const type = this.parseTypeArgument(name);
    this.consume(TokenType.RParen, `Expect ')' after the type ${name.value} holds.`);
    return type;
  }

  private parseTypeArgument(name: Token): Type {
    if (name.value === 'list' || name.value === 'set' || name.value === 'map') return types[name.value](this.parseType());

    return name.value === 'tuple' ? types.tuple(this.parseTupleTypes()) : types.object(this.parseObjectTypes());
  }

  private parseTupleTypes(): Type[] {
    this.consume(TokenType.LBracket, "Expect '[' after 'tuple('.");

    const elements: Type[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      elements.push(this.parseType());
      if (!this.matchToken(TokenType.Comma)) break;
    }

    this.consume(TokenType.RBracket, "Expect ']' after the types in a tuple.");
    return elements;
  }

  /** Written as a map is, with an identifier for each name. */
  private parseObjectTypes(): Record<string, Type> {
    this.consume(TokenType.LBrace, "Expect '{' after 'object('.");

    const attributes: Record<string, Type> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect an attribute name in an object type.');
      this.checkKey(attributes, key);
      this.consume(TokenType.Assign, "Expect '=' after the attribute name.");
      attributes[key.value] = this.parseType();
      this.matchToken(TokenType.Comma);
    }

    this.consume(TokenType.RBrace, "Expect '}' after the attributes of an object type.");
    return attributes;
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

    const { count, for_each: forEach, ...attributes } = this.parseAttributes('module');
    if (count && forEach) throw new ConfigError(`module "${nameToken.value}" has count or for_each, not both`, forEach.position);

    return {
      type: 'Module',
      name: nameToken.value,
      ...(count && { count }),
      ...(forEach && { forEach }),
      attributes,
      position,
    };
  }

  /** A data source makes no instances yet; there `count` or `for_each` would be taken for an input. */
  private refuseInstances(attributes: Record<string, AttributeValue>, block: string): void {
    for (const name of INSTANCE_ARGUMENTS) if (Object.hasOwn(attributes, name)) throw new ConfigError(`${block} cannot have ${name} yet`, attributes[name].position);
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
    if (this.matchToken(TokenType.Null)) return { type: 'Null', position };

    if (this.matchToken(TokenType.LBracket)) return this.parseList(position);
    if (this.matchToken(TokenType.LBrace)) return this.parseMap(position);

    if (this.check(TokenType.Identifier)) return this.parseNamed(position);

    return this.error(`Unexpected value: ${this.peek().value}`);
  }

  private parseNegative(position: Position): AttributeValue {
    const number = this.consume(TokenType.Number, "Expect a number after '-'.");

    return { type: 'Number', value: this.exactNumber(`-${number.value}`, position), position };
  }

  /** A string with `${ … }` in it is a template: its text, and what its interpolations read, each where it was written. */
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

  /** Text next to text is one piece, and a string with no `${ … }` in it is a `String`. */
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

  /** What one `${ … }` holds: a reference, a call or a name a for gives, and nothing else. The lexer has put `${` next. */
  private parseInterpolation(): ReferenceNode | CallNode | BoundNode {
    this.advance();
    if (!this.check(TokenType.Identifier)) return this.error("Expect a reference or a function call inside '${'.");

    const named = this.parseNamed(this.peek().position);
    this.consume(TokenType.TemplateEnd, `Expect '}' after the ${named.type === 'Call' ? 'function call' : 'reference'}.`);

    return named;
  }

  /** The text of a string that has no `${ … }` in it, as written; `quote` is the one that opened it. The lexer puts `"` after it. */
  private plainText(quote: Token, what: string): Token {
    const text = this.matchToken(TokenType.QuotedLit) ? this.previous() : { type: TokenType.QuotedLit, value: '', position: this.peek().position };
    if (this.check(TokenType.TemplateInterp)) throw new ConfigError(`A ${what} is plain text; it cannot hold an interpolation`, quote.position);

    this.advance();
    return text;
  }

  private parseList(position: Position): AttributeValue {
    // `for.` still starts a reference, to a resource of that type.
    if (this.checkWord('for') && this.tokens[this.current + 1].type !== TokenType.Dot) return this.parseFor(position, TokenType.RBracket);

    const values: AttributeValue[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      values.push(this.parseValue());
      if (!this.matchToken(TokenType.Comma)) break;
    }
    this.consume(TokenType.RBracket, "Expect ']' after list.");
    return { type: 'List', value: values, position };
  }

  /**
   * `[for key, value in collection : body]`, or `{for … : key => body}` for an object, with the bracket read and `for` next.
   * The names stand for the item in the key and the body only.
   */
  private parseFor(position: Position, closing: keyof typeof CLOSING): ForNode {
    this.advance();
    const names = this.parseForNames();
    if (!this.checkWord('in')) return this.error("Expect 'in' after the names in a for expression.");
    this.advance();

    const collection = this.parseValue();
    this.consume(TokenType.Colon, "Expect ':' after the collection in a for expression.");

    this.bound.push(...names.map((name) => name.value));
    const made = closing === TokenType.RBrace ? this.parseEntry() : { body: this.parseValue() };
    this.bound.splice(-names.length);

    this.consume(closing, `Expect '${CLOSING[closing]}' after the for expression.`);
    const [keyName, valueName] = names.length === 2 ? names.map((name) => name.value) : [undefined, names[0].value];
    return { type: 'For', ...(keyName && { keyName }), valueName, collection, ...made, position };
  }

  /** `key => body` in a for that makes an object, with `...` after the body to group the items of one key. */
  private parseEntry(): Pick<ForNode, 'key' | 'body' | 'grouped'> {
    const key = this.parseValue();
    this.consume(TokenType.FatArrow, "Expect '=>' after the key in a for expression.");
    const body = this.parseValue();

    return { key, body, ...(this.matchToken(TokenType.Ellipsis) && { grouped: true }) };
  }

  private parseForNames(): Token[] {
    const names = [this.forName("Expect a name after 'for'.")];
    if (!this.matchToken(TokenType.Comma)) return names;

    const second = this.forName("Expect a name after ','.");
    if (second.value === names[0].value) throw new ConfigError('The key and the value of a for need names of their own', second.position);

    return [...names, second];
  }

  /** A name a for gives hides any reference that starts with it, so it cannot be one a reference already spells. */
  private forName(message: string): Token {
    const name = this.consume(TokenType.Identifier, message);
    if (RESERVED_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" cannot name an item in a for: a reference reads "${name.value}." as something else`, name.position);
    if (this.bound.includes(name.value)) throw new ConfigError(`"${name.value}" is named by a for around this one already`, name.position);

    this.forNames.push(name);
    return name;
  }

  private parseMap(position: Position): AttributeValue {
    // `{ for = 1 }` is still a map with a key named for.
    if (this.checkWord('for') && this.tokens[this.current + 1].type !== TokenType.Assign) return this.parseFor(position, TokenType.RBrace);

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
  private checkKey(entries: object, key: Token): void {
    if (key.value === '__proto__') throw new ConfigError('__proto__ cannot be a name', key.position);
    if (Object.hasOwn(entries, key.value)) throw new ConfigError(`${key.value} is set twice`, key.position);
  }

  /** A name with `(` after it calls a function, one a for around it gives stands for its item, and any other name starts a reference. */
  private parseNamed(position: Position): ReferenceNode | CallNode | BoundNode {
    const name = this.advance().value;
    if (this.matchToken(TokenType.LParen)) return { type: 'Call', name, args: this.parseArguments(), path: this.parseSteps(), position };
    if (this.bound.includes(name)) return { type: 'Bound', value: [name, ...this.parseSteps()], position };

    return { type: 'Reference', value: [name, ...this.parseSteps()], position };
  }

  /** Written as a list's items are, with a comma between and one allowed after the last. The `(` is already read. */
  private parseArguments(): AttributeValue[] {
    const args: AttributeValue[] = [];
    while (!this.check(TokenType.RParen) && !this.isAtEnd()) {
      args.push(this.parseValue());
      if (!this.matchToken(TokenType.Comma)) break;
    }
    this.consume(TokenType.RParen, "Expect ')' after the arguments.");
    return args;
  }

  private parseSteps(): Step[] {
    const steps: Step[] = [];

    while (this.matchToken(TokenType.Dot, TokenType.LBracket))
      steps.push(this.previous().type === TokenType.Dot ? this.consume(TokenType.Identifier, 'Expect property name after dot.').value : this.parseBracket());

    return steps;
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
    if (!NAME.test(token.value) || KEYWORDS.has(token.value))
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

  /** A word special only where it is written, as `for` and `in` are in a for expression. */
  private checkWord(word: string): boolean {
    return this.check(TokenType.Identifier) && this.peek().value === word;
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

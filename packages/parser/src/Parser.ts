import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, Program, ResourceBlock, spell, Statement, VariableBlock } from './ast';
import { ConfigError } from './ConfigError';
import { Position } from './Position';
import { Token, TokenType } from './tokens';

/** What a reference can spell, so a declared name can always be read back. */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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

    const attributes = this.parseAttributes('variable');

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

    if (this.matchToken(TokenType.String)) return { type: 'String', value: this.previous().value, position };
    if (this.matchToken(TokenType.Number)) return { type: 'Number', value: Number(this.previous().value), position };
    if (this.matchToken(TokenType.Boolean)) return { type: 'Boolean', value: this.previous().value === 'true', position };

    if (this.matchToken(TokenType.LBracket)) return this.parseList(position);
    if (this.matchToken(TokenType.LBrace)) return this.parseMap(position);

    if (this.check(TokenType.Identifier)) return this.parseReference(position);

    return this.error(`Unexpected value: ${this.peek().value}`);
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
      const key = this.matchToken(TokenType.String) ? this.previous() : this.consume(TokenType.Identifier, 'Expect key in map.');
      this.checkKey(map, key);

      this.consume(TokenType.Assign, "Expect '=' after key in map.");
      map[key.value] = this.parseValue();
      this.matchToken(TokenType.Comma);
    }
    this.consume(TokenType.RBrace, "Expect '}' after map.");
    return { type: 'Map', value: map, position };
  }

  // A second value under one name would replace the first in silence, and `__proto__` would set a prototype, not a key.
  private checkKey(entries: Record<string, AttributeValue>, key: Token): void {
    if (key.value === '__proto__') throw new ConfigError('__proto__ cannot be a name', key.position);
    if (Object.hasOwn(entries, key.value)) throw new ConfigError(`${key.value} is set twice`, key.position);
  }

  private parseReference(position: Position): AttributeValue {
    const parts: string[] = [];

    parts.push(this.advance().value);

    while (this.matchToken(TokenType.Dot))
      if (this.check(TokenType.Identifier)) parts.push(this.advance().value);
      else return this.error('Expect property name after dot.');

    return { type: 'Reference', value: parts, position };
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
    const token = this.consume(TokenType.String, message);
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

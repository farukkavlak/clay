import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, Program, ResourceBlock, Statement, VariableBlock } from './ast';
import { Token, TokenType } from './tokens';

/** A block as the config spells it: `resource "local_file" "a"`, `module "m"`. */
function spell(statement: Statement): string {
  if (statement.type === 'Resource') return `resource "${statement.resourceType}" "${statement.name}"`;
  if (statement.type === 'Data') return `data "${statement.dataSourceType}" "${statement.name}"`;
  return `${statement.type.toLowerCase()} "${statement.name}"`;
}

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
      if (declared.has(label)) throw new Error(`[Line ${start.line}, Column ${start.column}] ${label} is declared twice`);
      declared.add(label);

      program.push(statement);
    }

    return program;
  }

  // No keywords: a kind is only special at the start of a statement.
  private blockParsers = new Map<string, () => Statement>([
    ['resource', this.parseResource.bind(this)],
    ['variable', this.parseVariable.bind(this)],
    ['data', this.parseData.bind(this)],
    ['output', this.parseOutput.bind(this)],
    ['module', this.parseModule.bind(this)],
  ]);

  private parseStatement(): Statement {
    const parseBlock = this.check(TokenType.Identifier) ? this.blockParsers.get(this.peek().value) : undefined;
    if (!parseBlock) return this.error(`Unexpected token: ${this.peek().value}`);

    this.advance();
    return parseBlock();
  }

  private parseResource(): ResourceBlock {
    const typeToken = this.consume(TokenType.String, "Expect resource type string after 'resource'.");
    const nameToken = this.consume(TokenType.String, 'Expect resource name string after resource type.');

    this.consume(TokenType.LBrace, "Expect '{' after resource name.");

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.').value;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.parseValue();
      attributes[key] = value;
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");

    return {
      type: 'Resource',
      resourceType: typeToken.value,
      name: nameToken.value,
      attributes,
    };
  }

  private parseData(): DataBlock {
    const typeToken = this.consume(TokenType.String, "Expect data source type string after 'data'.");
    const nameToken = this.consume(TokenType.String, 'Expect data source name string after data source type.');

    this.consume(TokenType.LBrace, "Expect '{' after data source name.");

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.').value;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.parseValue();
      attributes[key] = value;
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");

    return {
      type: 'Data',
      dataSourceType: typeToken.value,
      name: nameToken.value,
      attributes,
    };
  }

  private parseVariable(): VariableBlock {
    const nameToken = this.consume(TokenType.String, "Expect variable name string after 'variable'.");

    this.consume(TokenType.LBrace, "Expect '{' after variable name.");

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.').value;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.parseValue();
      attributes[key] = value;
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");

    return {
      type: 'Variable',
      name: nameToken.value,
      attributes,
    };
  }

  private parseOutput(): OutputBlock {
    const nameToken = this.consume(TokenType.String, "Expect output name string after 'output'.");

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
    };
  }

  private parseModule(): ModuleBlock {
    const nameToken = this.consume(TokenType.String, "Expect module name string after 'module'.");

    this.consume(TokenType.LBrace, "Expect '{' after module name.");

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.').value;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.parseValue();
      attributes[key] = value;
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");

    return {
      type: 'Module',
      name: nameToken.value,
      attributes,
    };
  }

  private parseValue(): AttributeValue {
    if (this.matchToken(TokenType.String)) return { type: 'String', value: this.previous().value };
    if (this.matchToken(TokenType.Number)) return { type: 'Number', value: Number(this.previous().value) };
    if (this.matchToken(TokenType.Boolean)) return { type: 'Boolean', value: this.previous().value === 'true' };

    if (this.matchToken(TokenType.LBracket)) return this.parseList();
    if (this.matchToken(TokenType.LBrace)) return this.parseMap();

    if (this.check(TokenType.Identifier)) return this.parseReference();

    return this.error(`Unexpected value: ${this.peek().value}`);
  }

  private parseList(): AttributeValue {
    const values: AttributeValue[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      values.push(this.parseValue());
      if (!this.matchToken(TokenType.Comma)) break;
    }
    this.consume(TokenType.RBracket, "Expect ']' after list.");
    return { type: 'List', value: values };
  }

  private parseMap(): AttributeValue {
    const map: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.matchToken(TokenType.String) ? this.previous().value : this.consume(TokenType.Identifier, 'Expect key in map.').value;

      this.consume(TokenType.Assign, "Expect '=' after key in map.");
      map[key] = this.parseValue();
      this.matchToken(TokenType.Comma);
    }
    this.consume(TokenType.RBrace, "Expect '}' after map.");
    return { type: 'Map', value: map };
  }

  private parseReference(): AttributeValue {
    const parts: string[] = [];

    parts.push(this.advance().value);

    while (this.matchToken(TokenType.Dot))
      if (this.check(TokenType.Identifier)) parts.push(this.advance().value);
      else return this.error('Expect property name after dot.');

    return { type: 'Reference', value: parts };
  }

  private matchToken(...types: TokenType[]): boolean {
    for (const type of types)
      if (this.check(type)) {
        this.advance();
        return true;
      }
    return false;
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    return this.error(message);
  }

  private error(message: string): never {
    const token = this.peek();
    throw new Error(`[Line ${token.line}, Column ${token.column}] ${message}`);
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

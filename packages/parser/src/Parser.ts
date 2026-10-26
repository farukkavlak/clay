import { isName, NAME_RULE, RESERVED_TYPES, Type, types } from '@clay/contracts';

import {
  AttributeValue,
  DataBlock,
  IgnoredPath,
  Lifecycle,
  LocalBlock,
  ModuleBlock,
  namedIn,
  OutputBlock,
  Program,
  ReferenceNode,
  ResourceBlock,
  spell,
  spellNamed,
  Statement,
  TypeDefaults,
  Validation,
  VariableBlock,
} from './ast';
import { checkKey } from './checkKey';
import { ConfigError } from './ConfigError';
import { ExpressionParser } from './ExpressionParser';
import { Position } from './Position';
import { ParsedReference, parseReference, spellReference, Step, stepKey } from './reference';
import { Token, TokenType } from './tokens';
import { TokenStream } from './TokenStream';

const PRIMITIVE_TYPES = new Map<string, Type>([
  ['string', types.string],
  ['number', types.number],
  ['bool', types.bool],
  ['any', types.dynamic],
]);

const HOLDING_TYPES = new Set(['list', 'set', 'map', 'tuple', 'object']);

/** Reserved by a module call, so no module input may use them. */
const CALL_ARGUMENTS = new Set(['count', 'for_each', 'depends_on']);

interface TypedBody {
  attributes: Record<string, AttributeValue>;
  declared?: ParsedType;
  flagged?: boolean;
  validations: Validation[];
}

interface ParsedType {
  type: Type;
  defaults?: TypeDefaults;
}

interface AttributeType extends ParsedType {
  optional?: true;
  default?: AttributeValue;
}

/** Drops empty records, so a type without defaults has no `defaults`. */
function defaultsFrom(found: { values?: Record<string, AttributeValue>; within?: Record<string, TypeDefaults> }): Pick<ParsedType, 'defaults'> {
  const defaults = Object.fromEntries(Object.entries(found).filter(([, record]) => Object.keys(record).length > 0));
  return Object.keys(defaults).length > 0 ? { defaults } : {};
}

const readsVariable = (reference: ParsedReference, name: string) => reference.kind === 'variable' && reference.name === name;

const WAITED_FOR = new Set<ParsedReference['kind']>(['resource', 'data', 'variable', 'local', 'module']);
const WAITS_FOR = 'depends_on is a list of resources, data sources, variables, locals, modules and their outputs, as in [local_file.a]';

/** The one step a whole object may have: the output of a module. */
const outputStep = (reference: ParsedReference) => (reference.kind === 'module' && reference.path.length > 0 && 'name' in reference.path[0] ? 1 : 0);

/** The nearest whole object: `module.m.out` for `module.m[0].out`, since `module.m` would wait for more. */
function wholeOf(parts: Step[], reference: ParsedReference): Step[] {
  const head = parts.slice(0, parts.length - reference.path.length);
  const [first, second] = reference.path;
  if (reference.kind === 'module' && !('name' in first) && second && 'name' in second) return [...head, second];

  return [...head, ...reference.path.slice(0, outputStep(reference))];
}

/** The graph orders blocks, not instances, so an index could not mean what it says. */
function waitedFor(item: AttributeValue): ReferenceNode {
  if (item.type !== 'Reference') throw new ConfigError(WAITS_FOR, item.position);

  const reference = parseReference(item.value, item.position);
  if (!WAITED_FOR.has(reference.kind)) throw new ConfigError(WAITS_FOR, item.position);
  if (reference.path.length > outputStep(reference)) {
    const whole = spellReference(wholeOf(item.value, reference));
    throw new ConfigError(`depends_on waits for a whole object: write ${whole}, not ${spellReference(item.value)}`, item.position);
  }

  return item;
}

/** Read as written, so the order is known before any value is. */
function dependsOnOf(value: AttributeValue): ReferenceNode[] {
  if (value.type !== 'List') throw new ConfigError(WAITS_FOR, value.position);

  return value.value.map((item) => waitedFor(item));
}

export class Parser {
  private readonly stream: TokenStream;
  private readonly expressions: ExpressionParser;

  constructor(tokens: Token[]) {
    this.stream = new TokenStream(tokens);
    this.expressions = new ExpressionParser(this.stream);
  }

  public parse(): Program {
    const program: Program = [];
    const declared = new Set<string>();

    while (!this.stream.isAtEnd())
      for (const statement of this.parseStatements()) {
        // A duplicate would silently replace the first.
        const label = spell(statement);
        if (declared.has(label)) throw new ConfigError(`${label} is declared twice`, statement.position);
        declared.add(label);

        program.push(statement);
      }

    this.checkForNames(program);
    return program;
  }

  /** A for name that equals a resource type would shadow every reference to that type. */
  private checkForNames(program: Program): void {
    const types = new Set(program.flatMap((statement) => (statement.type === 'Resource' ? [statement.resourceType] : [])));
    const shadowing = this.expressions.forNames.find((name) => types.has(name.value));
    if (shadowing)
      throw new ConfigError(`"${shadowing.value}" cannot name an item in a for: a reference reads "${shadowing.value}." as a resource of that type`, shadowing.position);
  }

  // Not keywords: a block kind is only special at the start of a statement.
  private blockParsers = new Map<string, (position: Position) => Statement>([
    ['resource', this.parseResource.bind(this)],
    ['variable', this.parseVariable.bind(this)],
    ['data', this.parseData.bind(this)],
    ['output', this.parseOutput.bind(this)],
    ['module', this.parseModule.bind(this)],
  ]);

  private parseStatements(): Statement[] {
    return this.stream.checkWord('locals') ? this.parseLocals() : [this.parseStatement()];
  }

  /** A statement for each name, so several blocks merge and a name set twice is a duplicate like any other. */
  private parseLocals(): LocalBlock[] {
    this.stream.advance();
    this.stream.consume(TokenType.LBrace, "Expect '{' after 'locals'.");

    const locals: LocalBlock[] = [];
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect the name of a local.');
      this.stream.consume(TokenType.Assign, "Expect '=' after the name of a local.");
      locals.push({ type: 'Local', name: key.value, value: this.expressions.parseValue(), position: key.position });
    }

    this.stream.consume(TokenType.RBrace, "Expect '}' after block body.");
    return locals;
  }

  private parseStatement(): Statement {
    const parseBlock = this.stream.check(TokenType.Identifier) ? this.blockParsers.get(this.stream.peek().value) : undefined;
    if (!parseBlock) return this.stream.error(`Unexpected token: ${this.stream.peek().value}`);

    return parseBlock(this.stream.advance().position);
  }

  private parseResource(position: Position): ResourceBlock {
    const typeToken = this.consumeType("Expect resource type string after 'resource'.");
    const nameToken = this.consumeName('Expect resource name string after resource type.');

    let lifecycle: Lifecycle | undefined;
    const {
      count,
      for_each: forEach,
      depends_on: dependsOn,
      ...attributes
    } = this.parseAttributes('resource', {
      lifecycle: (key) => {
        if (lifecycle) throw new ConfigError(`resource "${typeToken.value}" "${nameToken.value}" has two lifecycle blocks`, key.position);
        lifecycle = this.parseLifecycle(key.position);
      },
    });
    if (count && forEach) throw new ConfigError(`resource "${typeToken.value}" "${nameToken.value}" has count or for_each, not both`, forEach.position);

    return {
      type: 'Resource',
      resourceType: typeToken.value,
      name: nameToken.value,
      ...(count && { count }),
      ...(forEach && { forEach }),
      ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
      ...(lifecycle && { lifecycle }),
      attributes,
      position,
    };
  }

  /** Read with the block, before any reference has a value, so what it holds is written out. */
  private parseLifecycle(position: Position): Lifecycle {
    this.stream.consume(TokenType.LBrace, "Expect '{' after 'lifecycle'.");

    const seen: Record<string, true> = {};
    const lifecycle: Lifecycle = { position };
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect an argument name.');
      checkKey(seen, key);
      seen[key.value] = true;
      this.stream.consume(TokenType.Assign, "Expect '=' after the argument name.");
      this.parseLifecycleArgument(key, lifecycle);
    }

    this.stream.consume(TokenType.RBrace, "Expect '}' after lifecycle body.");
    return lifecycle;
  }

  private parseLifecycleArgument(key: Token, lifecycle: Lifecycle): void {
    switch (key.value) {
      case 'prevent_destroy': {
        lifecycle.preventDestroy = this.stream.consume(TokenType.Boolean, 'prevent_destroy is true or false.').value === 'true';
        break;
      }
      case 'create_before_destroy': {
        lifecycle.createBeforeDestroy = this.stream.consume(TokenType.Boolean, 'create_before_destroy is true or false.').value === 'true';
        break;
      }
      case 'ignore_changes': {
        lifecycle.ignoreChanges = this.parseIgnoreChanges();
        break;
      }
      default: {
        throw new ConfigError(`lifecycle takes only "prevent_destroy", "create_before_destroy" and "ignore_changes", not "${key.value}"`, key.position);
      }
    }
  }

  /** `all`, or a list of attributes: `[content, tags["Name"], items[0]]`. */
  private parseIgnoreChanges(): 'all' | IgnoredPath[] {
    if (this.stream.checkWord('all')) {
      this.stream.advance();
      return 'all';
    }

    this.stream.consume(TokenType.LBracket, 'ignore_changes is a list of attributes, or all.');
    const paths: IgnoredPath[] = [];
    while (!this.stream.check(TokenType.RBracket) && !this.stream.isAtEnd()) {
      paths.push(this.parseIgnoredPath());
      if (!this.stream.matchToken(TokenType.Comma)) break;
    }

    this.stream.consume(TokenType.RBracket, "Expect ']' after ignore_changes.");
    return paths;
  }

  private parseIgnoredPath(): IgnoredPath {
    const first = this.stream.consume(TokenType.Identifier, 'ignore_changes names an attribute, written without quotes.');
    if (first.value === 'all') throw new ConfigError('all is written alone, not in a list', first.position);

    const path: (string | number)[] = [first.value];
    for (const step of this.expressions.parseSteps()) {
      if ('index' in step) throw new ConfigError('ignore_changes names keys and indexes written out, not a value to read', first.position);
      path.push(stepKey(step));
    }
    if (this.expressions.atSplat()) throw new ConfigError('ignore_changes names keys and indexes written out, not [*]', first.position);

    return { path, position: first.position };
  }

  private parseData(position: Position): DataBlock {
    const typeToken = this.consumeType("Expect data source type string after 'data'.");
    const nameToken = this.consumeName('Expect data source name string after data source type.');

    const { count, for_each: forEach, depends_on: dependsOn, ...attributes } = this.parseAttributes('data source');
    if (count && forEach) throw new ConfigError(`data "${typeToken.value}" "${nameToken.value}" has count or for_each, not both`, forEach.position);

    return {
      type: 'Data',
      dataSourceType: typeToken.value,
      name: nameToken.value,
      ...(count && { count }),
      ...(forEach && { forEach }),
      ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
      attributes,
      position,
    };
  }

  private parseVariable(position: Position): VariableBlock {
    const nameToken = this.consumeName("Expect variable name string after 'variable'.");
    if (nameToken.value === 'source') throw new ConfigError('"source" cannot be a variable name: a module call reads it as the module\'s path.', nameToken.position);
    if (CALL_ARGUMENTS.has(nameToken.value)) throw new ConfigError(`"${nameToken.value}" cannot be a variable name: a module call keeps it for itself.`, nameToken.position);

    this.stream.consume(TokenType.LBrace, "Expect '{' after variable name.");
    const { attributes, declared, flagged, validations } = this.parseTypedBody(`Variable "${nameToken.value}"`, 'default', { flag: 'sensitive', variable: nameToken.value });

    // A module input replaces the default, so a reference or a call in it might never be checked.
    if (attributes.default) this.checkConstant(attributes.default, "A variable's default");

    return {
      type: 'Variable',
      name: nameToken.value,
      attributes,
      ...(declared && { valueType: declared.type }),
      ...(declared?.defaults && { defaults: declared.defaults }),
      ...(flagged && { sensitive: true }),
      ...(validations.length > 0 && { validations }),
      position,
    };
  }

  private checkConstant(value: AttributeValue, what: string): void {
    const [named] = namedIn(value);
    if (named) throw new ConfigError(`${what} is a constant, so it cannot hold ${spellNamed(named)}`, named.position);
  }

  /**
   * Only the one value, `type`, the flag where the block has one, and a description; any other name is refused, since nothing would read it.
   * A variable's block, named by `variable`, takes `validation` blocks too, and a block that `waits` takes `depends_on`.
   */
  private parseTypedBody(block: string, valueName: string, { flag, variable, waits }: { flag?: string; variable?: string; waits?: true } = {}): TypedBody {
    const body: TypedBody = { attributes: {}, validations: [] };
    const names = [valueName, 'type', ...(flag ? [flag] : []), 'description', ...(waits ? ['depends_on'] : [])].map((name) => `"${name}"`);
    const taken = `${block} takes only ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const seen: Record<string, true> = {};
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect attribute name.');
      if (variable !== undefined && key.value === 'validation') {
        body.validations.push(this.parseValidation(variable, key.position));
        continue;
      }

      if (this.stream.check(TokenType.LBrace))
        throw new ConfigError(`${block} takes ${variable === undefined ? 'no blocks' : 'only validation blocks'}, not a "${key.value}" block.`, key.position);

      checkKey(seen, key);
      seen[key.value] = true;
      this.stream.consume(TokenType.Assign, "Expect '=' after attribute name.");
      this.parseTypedAttribute(key.value, body, { valueName, flag, waits, taken });
    }

    this.stream.consume(TokenType.RBrace, "Expect '}' after block body.");
    return body;
  }

  private parseTypedAttribute(name: string, body: TypedBody, { valueName, flag, waits, taken }: { valueName: string; flag?: string; waits?: true; taken: string }): void {
    if (name === 'type') {
      body.declared = this.parseType();
      return;
    }
    if (name === flag) {
      // Read with the block, before any reference has a value.
      body.flagged = this.stream.consume(TokenType.Boolean, `${flag} is true or false.`).value === 'true';
      return;
    }

    const value = this.expressions.parseValue();
    if (name === 'description') this.checkDescription(value);
    else if (name === valueName || (waits && name === 'depends_on')) body.attributes[name] = value;
    else throw new ConfigError(`${taken}, not "${name}".`, value.position);
  }

  private parseValidation(variable: string, position: Position): Validation {
    this.stream.consume(TokenType.LBrace, "Expect '{' after validation.");
    const read: Record<string, AttributeValue> = {};
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect attribute name.');
      checkKey(read, key);
      this.stream.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.expressions.parseValue();
      if (key.value !== 'condition' && key.value !== 'error_message')
        throw new ConfigError(`validation takes only "condition" and "error_message", not "${key.value}".`, value.position);
      read[key.value] = value;
    }
    this.stream.consume(TokenType.RBrace, "Expect '}' after validation body.");

    const { condition, error_message: errorMessage } = read;
    if (condition === undefined || errorMessage === undefined) throw new ConfigError(`validation needs ${condition ? 'an error_message' : 'a condition'}`, position);
    if (!namedIn(condition).some((named) => named.type === 'Reference' && readsVariable(parseReference(named.value, named.position), variable)))
      throw new ConfigError(`A validation's condition reads var.${variable}, or it checks nothing`, condition.position);

    return { condition, errorMessage, position };
  }

  /** Read by people only, so it is checked and dropped. */
  private checkDescription(value: AttributeValue): void {
    if (value.type !== 'String') throw new ConfigError('A description is plain text, in quotes or a heredoc, with no ${...}', value.position);
  }

  private parseType(): ParsedType {
    if (this.stream.check(TokenType.OQuote)) return this.stream.error('A type is written without quotes: string, not "string"');
    const name = this.stream.consume(TokenType.Identifier, 'Expect a type: string, number, bool, any, list(...), set(...), map(...), tuple([...]) or object({...}).');
    if (name.value === 'optional') throw new ConfigError("optional(...) is written only as the type of an object's attribute", name.position);

    const primitive = PRIMITIVE_TYPES.get(name.value);
    if (primitive && this.stream.check(TokenType.LParen)) throw new ConfigError(`${name.value} holds no other type, so it takes no '('`, this.stream.peek().position);
    if (primitive) return { type: primitive };
    if (!HOLDING_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" is not a type: a type is string, number, bool, any, list, set, map, tuple or object`, name.position);

    this.stream.consume(TokenType.LParen, `Expect '(' after ${name.value}.`);
    const parsed = this.stream.nested(name.position, () => this.parseTypeArgument(name));
    this.stream.consume(TokenType.RParen, `Expect ')' after the type ${name.value} holds.`);
    return parsed;
  }

  private parseTypeArgument(name: Token): ParsedType {
    if (name.value === 'list' || name.value === 'set' || name.value === 'map') {
      const { type, defaults } = this.parseType();
      return { type: types[name.value](type), ...(defaults && { defaults: { element: defaults } }) };
    }

    return name.value === 'tuple' ? this.parseTupleTypes() : this.parseObjectTypes();
  }

  private parseTupleTypes(): ParsedType {
    this.stream.consume(TokenType.LBracket, "Expect '[' after 'tuple('.");

    const elements: Type[] = [];
    const within: Record<string, TypeDefaults> = {};
    while (!this.stream.check(TokenType.RBracket) && !this.stream.isAtEnd()) {
      const { type, defaults } = this.parseType();
      if (defaults) within[elements.length] = defaults;
      elements.push(type);
      if (!this.stream.matchToken(TokenType.Comma)) break;
    }

    this.stream.consume(TokenType.RBracket, "Expect ']' after the types in a tuple.");
    return { type: types.tuple(elements), ...defaultsFrom({ within }) };
  }

  private parseObjectTypes(): ParsedType {
    this.stream.consume(TokenType.LBrace, "Expect '{' after 'object('.");

    const attributes: Record<string, Type> = {};
    const optional: string[] = [];
    const values: Record<string, AttributeValue> = {};
    const within: Record<string, TypeDefaults> = {};
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect an attribute name in an object type.');
      checkKey(attributes, key);
      this.stream.consume(TokenType.Assign, "Expect '=' after the attribute name.");

      const attribute = this.parseAttributeType();
      attributes[key.value] = attribute.type;
      if (attribute.optional) optional.push(key.value);
      if (attribute.default) values[key.value] = attribute.default;
      if (attribute.defaults) within[key.value] = attribute.defaults;
      this.stream.matchToken(TokenType.Comma);
    }

    this.stream.consume(TokenType.RBrace, "Expect '}' after the attributes of an object type.");
    return { type: types.object(attributes, optional.length > 0 ? optional : undefined), ...defaultsFrom({ values, within }) };
  }

  private parseAttributeType(): AttributeType {
    if (!this.stream.check(TokenType.Identifier) || this.stream.peek().value !== 'optional') return this.parseType();
    this.stream.advance();
    this.stream.consume(TokenType.LParen, "Expect '(' after optional.");

    const parsed = this.parseType();
    const value = this.stream.matchToken(TokenType.Comma) ? this.expressions.parseValue() : undefined;
    // Types are read at declaration, before any reference has a value.
    if (value) this.checkConstant(value, "An optional attribute's default");

    this.stream.consume(TokenType.RParen, "Expect ')' after the type of optional, or its default.");
    return { ...parsed, optional: true, ...(value && { default: value }) };
  }

  private parseOutput(position: Position): OutputBlock {
    const nameToken = this.consumeName("Expect output name string after 'output'.");

    this.stream.consume(TokenType.LBrace, "Expect '{' after output name.");
    const { attributes, declared, flagged } = this.parseTypedBody(`Output "${nameToken.value}"`, 'value', { flag: 'sensitive', waits: true });
    if (!attributes.value) throw new ConfigError(`Output "${nameToken.value}" has no "value".`, position);

    return {
      type: 'Output',
      name: nameToken.value,
      value: attributes.value,
      ...(declared && { valueType: declared.type }),
      ...(declared?.defaults && { defaults: declared.defaults }),
      ...(flagged && { sensitive: true }),
      ...(attributes.depends_on && { dependsOn: dependsOnOf(attributes.depends_on) }),
      position,
    };
  }

  private parseModule(position: Position): ModuleBlock {
    const nameToken = this.consumeName("Expect module name string after 'module'.");

    const { count, for_each: forEach, depends_on: dependsOn, ...attributes } = this.parseAttributes('module');
    if (count && forEach) throw new ConfigError(`module "${nameToken.value}" has count or for_each, not both`, forEach.position);

    return {
      type: 'Module',
      name: nameToken.value,
      ...(count && { count }),
      ...(forEach && { forEach }),
      ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
      attributes,
      position,
    };
  }

  /** A name in `nested` followed by `{` is a block inside this one, read by its function instead of as an attribute. */
  private parseAttributes(block: string, nested: Record<string, (key: Token) => void> = {}): Record<string, AttributeValue> {
    this.stream.consume(TokenType.LBrace, `Expect '{' after ${block} name.`);

    const attributes: Record<string, AttributeValue> = {};
    while (!this.stream.check(TokenType.RBrace) && !this.stream.isAtEnd()) {
      const key = this.stream.consume(TokenType.Identifier, 'Expect attribute name.');
      if (Object.hasOwn(nested, key.value) && this.stream.check(TokenType.LBrace)) {
        nested[key.value](key);
        continue;
      }

      checkKey(attributes, key);
      this.stream.consume(TokenType.Assign, "Expect '=' after attribute name.");
      attributes[key.value] = this.expressions.parseValue();
    }

    this.stream.consume(TokenType.RBrace, "Expect '}' after block body.");
    return attributes;
  }

  /** Names end up in addresses, which split on dots, so a name must be an identifier. */
  private consumeName(message: string, word: 'name' | 'type' = 'name'): Token {
    const quote = this.stream.consume(TokenType.OQuote, message);
    const token = { ...quote, value: this.stream.plainText(quote, 'label').value };
    if (!isName(token.value)) throw new ConfigError(`Invalid ${word} "${token.value}": a ${word} ${NAME_RULE}.`, token.position);

    return token;
  }

  /** Same rule as a name, and it cannot be a reference prefix. */
  private consumeType(message: string): Token {
    const token = this.consumeName(message, 'type');
    if (RESERVED_TYPES.has(token.value)) throw new ConfigError(`"${token.value}" cannot be a type: a reference reads "${token.value}." as something else.`, token.position);

    return token;
  }
}

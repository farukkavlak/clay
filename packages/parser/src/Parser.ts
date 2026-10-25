import { ExactNumber, isName, MAX_NESTING, NAME_RULE, NumberError, RESERVED_TYPES, Type, types } from '@clay/contracts';
import {
  AttributeValue,
  BinaryOperator,
  BoundNode,
  CallNode,
  DataBlock,
  ForNode,
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
  spellIndex,
  spellNamed,
  Statement,
  TemplatePart,
  TypeDefaults,
  Validation,
  VariableBlock,
} from './ast';
import { ConfigError } from './ConfigError';
import { readEscapes } from './escapes';
import { flushed } from './heredoc';
import { Position } from './Position';
import { ParsedReference, parseReference, spellReference, Step, stepKey } from './reference';
import { Token, TokenType } from './tokens';

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

const CLOSING = { [TokenType.RBracket]: ']', [TokenType.RBrace]: '}' };

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
  private tokens: Token[];
  private current: number = 0;
  /** Names bound by enclosing for expressions, innermost last. */
  private bound: string[] = [];
  /** Checked against resource types once every block is read. */
  private forNames: Token[] = [];
  /** Openings around what is being read. */
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public parse(): Program {
    const program: Program = [];
    const declared = new Set<string>();

    while (!this.isAtEnd())
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
    const shadowing = this.forNames.find((name) => types.has(name.value));
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
    return this.checkWord('locals') ? this.parseLocals() : [this.parseStatement()];
  }

  /** A statement for each name, so several blocks merge and a name set twice is a duplicate like any other. */
  private parseLocals(): LocalBlock[] {
    this.advance();
    this.consume(TokenType.LBrace, "Expect '{' after 'locals'.");

    const locals: LocalBlock[] = [];
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect the name of a local.');
      this.consume(TokenType.Assign, "Expect '=' after the name of a local.");
      locals.push({ type: 'Local', name: key.value, value: this.parseValue(), position: key.position });
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");
    return locals;
  }

  private parseStatement(): Statement {
    const parseBlock = this.check(TokenType.Identifier) ? this.blockParsers.get(this.peek().value) : undefined;
    if (!parseBlock) return this.error(`Unexpected token: ${this.peek().value}`);

    return parseBlock(this.advance().position);
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
    this.consume(TokenType.LBrace, "Expect '{' after 'lifecycle'.");

    const seen: Record<string, true> = {};
    const lifecycle: Lifecycle = { position };
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect an argument name.');
      this.checkKey(seen, key);
      seen[key.value] = true;
      this.consume(TokenType.Assign, "Expect '=' after the argument name.");
      this.parseLifecycleArgument(key, lifecycle);
    }

    this.consume(TokenType.RBrace, "Expect '}' after lifecycle body.");
    return lifecycle;
  }

  private parseLifecycleArgument(key: Token, lifecycle: Lifecycle): void {
    switch (key.value) {
      case 'prevent_destroy': {
        lifecycle.preventDestroy = this.consume(TokenType.Boolean, 'prevent_destroy is true or false.').value === 'true';
        break;
      }
      case 'create_before_destroy': {
        lifecycle.createBeforeDestroy = this.consume(TokenType.Boolean, 'create_before_destroy is true or false.').value === 'true';
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
    if (this.checkWord('all')) {
      this.advance();
      return 'all';
    }

    this.consume(TokenType.LBracket, 'ignore_changes is a list of attributes, or all.');
    const paths: IgnoredPath[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      paths.push(this.parseIgnoredPath());
      if (!this.matchToken(TokenType.Comma)) break;
    }

    this.consume(TokenType.RBracket, "Expect ']' after ignore_changes.");
    return paths;
  }

  private parseIgnoredPath(): IgnoredPath {
    const first = this.consume(TokenType.Identifier, 'ignore_changes names an attribute, written without quotes.');
    if (first.value === 'all') throw new ConfigError('all is written alone, not in a list', first.position);

    const path: (string | number)[] = [first.value];
    for (const step of this.parseSteps()) {
      if ('index' in step) throw new ConfigError('ignore_changes names keys and indexes written out, not a value to read', first.position);
      path.push(stepKey(step));
    }
    if (this.atSplat()) throw new ConfigError('ignore_changes names keys and indexes written out, not [*]', first.position);

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

    this.consume(TokenType.LBrace, "Expect '{' after variable name.");
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
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.');
      if (variable !== undefined && key.value === 'validation') {
        body.validations.push(this.parseValidation(variable, key.position));
        continue;
      }

      if (this.check(TokenType.LBrace))
        throw new ConfigError(`${block} takes ${variable === undefined ? 'no blocks' : 'only validation blocks'}, not a "${key.value}" block.`, key.position);

      this.checkKey(seen, key);
      seen[key.value] = true;
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      this.parseTypedAttribute(key.value, body, { valueName, flag, waits, taken });
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");
    return body;
  }

  private parseTypedAttribute(name: string, body: TypedBody, { valueName, flag, waits, taken }: { valueName: string; flag?: string; waits?: true; taken: string }): void {
    if (name === 'type') {
      body.declared = this.parseType();
      return;
    }
    if (name === flag) {
      // Read with the block, before any reference has a value.
      body.flagged = this.consume(TokenType.Boolean, `${flag} is true or false.`).value === 'true';
      return;
    }

    const value = this.parseValue();
    if (name === 'description') this.checkDescription(value);
    else if (name === valueName || (waits && name === 'depends_on')) body.attributes[name] = value;
    else throw new ConfigError(`${taken}, not "${name}".`, value.position);
  }

  private parseValidation(variable: string, position: Position): Validation {
    this.consume(TokenType.LBrace, "Expect '{' after validation.");
    const read: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.');
      this.checkKey(read, key);
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      const value = this.parseValue();
      if (key.value !== 'condition' && key.value !== 'error_message')
        throw new ConfigError(`validation takes only "condition" and "error_message", not "${key.value}".`, value.position);
      read[key.value] = value;
    }
    this.consume(TokenType.RBrace, "Expect '}' after validation body.");

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
    if (this.check(TokenType.OQuote)) return this.error('A type is written without quotes: string, not "string"');
    const name = this.consume(TokenType.Identifier, 'Expect a type: string, number, bool, any, list(...), set(...), map(...), tuple([...]) or object({...}).');
    if (name.value === 'optional') throw new ConfigError("optional(...) is written only as the type of an object's attribute", name.position);

    const primitive = PRIMITIVE_TYPES.get(name.value);
    if (primitive && this.check(TokenType.LParen)) throw new ConfigError(`${name.value} holds no other type, so it takes no '('`, this.peek().position);
    if (primitive) return { type: primitive };
    if (!HOLDING_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" is not a type: a type is string, number, bool, any, list, set, map, tuple or object`, name.position);

    this.consume(TokenType.LParen, `Expect '(' after ${name.value}.`);
    const parsed = this.nested(name.position, () => this.parseTypeArgument(name));
    this.consume(TokenType.RParen, `Expect ')' after the type ${name.value} holds.`);
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
    this.consume(TokenType.LBracket, "Expect '[' after 'tuple('.");

    const elements: Type[] = [];
    const within: Record<string, TypeDefaults> = {};
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      const { type, defaults } = this.parseType();
      if (defaults) within[elements.length] = defaults;
      elements.push(type);
      if (!this.matchToken(TokenType.Comma)) break;
    }

    this.consume(TokenType.RBracket, "Expect ']' after the types in a tuple.");
    return { type: types.tuple(elements), ...defaultsFrom({ within }) };
  }

  private parseObjectTypes(): ParsedType {
    this.consume(TokenType.LBrace, "Expect '{' after 'object('.");

    const attributes: Record<string, Type> = {};
    const optional: string[] = [];
    const values: Record<string, AttributeValue> = {};
    const within: Record<string, TypeDefaults> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect an attribute name in an object type.');
      this.checkKey(attributes, key);
      this.consume(TokenType.Assign, "Expect '=' after the attribute name.");

      const attribute = this.parseAttributeType();
      attributes[key.value] = attribute.type;
      if (attribute.optional) optional.push(key.value);
      if (attribute.default) values[key.value] = attribute.default;
      if (attribute.defaults) within[key.value] = attribute.defaults;
      this.matchToken(TokenType.Comma);
    }

    this.consume(TokenType.RBrace, "Expect '}' after the attributes of an object type.");
    return { type: types.object(attributes, optional.length > 0 ? optional : undefined), ...defaultsFrom({ values, within }) };
  }

  private parseAttributeType(): AttributeType {
    if (!this.check(TokenType.Identifier) || this.peek().value !== 'optional') return this.parseType();
    this.advance();
    this.consume(TokenType.LParen, "Expect '(' after optional.");

    const parsed = this.parseType();
    const value = this.matchToken(TokenType.Comma) ? this.parseValue() : undefined;
    // Types are read at declaration, before any reference has a value.
    if (value) this.checkConstant(value, "An optional attribute's default");

    this.consume(TokenType.RParen, "Expect ')' after the type of optional, or its default.");
    return { ...parsed, optional: true, ...(value && { default: value }) };
  }

  private parseOutput(position: Position): OutputBlock {
    const nameToken = this.consumeName("Expect output name string after 'output'.");

    this.consume(TokenType.LBrace, "Expect '{' after output name.");
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
    this.consume(TokenType.LBrace, `Expect '{' after ${block} name.`);

    const attributes: Record<string, AttributeValue> = {};
    while (!this.check(TokenType.RBrace) && !this.isAtEnd()) {
      const key = this.consume(TokenType.Identifier, 'Expect attribute name.');
      if (Object.hasOwn(nested, key.value) && this.check(TokenType.LBrace)) {
        nested[key.value](key);
        continue;
      }

      this.checkKey(attributes, key);
      this.consume(TokenType.Assign, "Expect '=' after attribute name.");
      attributes[key.value] = this.parseValue();
    }

    this.consume(TokenType.RBrace, "Expect '}' after block body.");
    return attributes;
  }

  /** `a ? b : c` binds loosest, and either result may be a conditional too. */
  private parseValue(): AttributeValue {
    const condition = this.parseBinary(0);
    if (!this.matchToken(TokenType.Question)) return condition;

    return this.nested(this.previous().position, () => {
      const whenTrue = this.parseValue();
      this.consume(TokenType.Colon, "Expect ':' after the value a conditional gives when true.");

      return { type: 'Conditional', condition, whenTrue, whenFalse: this.parseValue(), position: condition.position };
    });
  }

  /** A chain is as deep as it is long, so each operator in it counts toward the nesting limit. */
  private parseBinary(level: number): AttributeValue {
    if (level === BINARY_LEVELS.length) return this.parseUnary();

    const outer = this.depth;
    try {
      let left = this.parseBinary(level + 1);
      for (let operator = this.matchOperator(level); operator; operator = this.matchOperator(level)) {
        const operatorPosition = this.previous().position;
        this.enter(operatorPosition);
        left = { type: 'Binary', operator, operatorPosition, left, right: this.parseBinary(level + 1), position: left.position };
      }

      return left;
    } finally {
      this.depth = outer;
    }
  }

  private matchOperator(level: number): BinaryOperator | undefined {
    const operator = BINARY_LEVELS[level].get(this.peek().type);
    if (operator) this.advance();

    return operator;
  }

  private parseUnary(): AttributeValue {
    const { position } = this.peek();
    if (this.matchToken(TokenType.Bang)) return this.nested(position, () => ({ type: 'Not', value: this.parseUnary(), position }));
    if (this.matchToken(TokenType.Minus)) return this.parseNegative(position);

    return this.parsePrimary();
  }

  private parsePrimary(): AttributeValue {
    const { position } = this.peek();
    const value = this.parseTerm();
    const path = this.parseSteps();

    return this.splatted(path.length === 0 ? value : { type: 'Index', value, path, position });
  }

  /** `[*]` reads every step after it, a `[*]` among them, into each item; parentheses end it. */
  private splatted(collection: AttributeValue): AttributeValue {
    if (!this.atSplat()) return collection;
    this.current += 3;

    const { position } = collection;
    const valueName = `${spellIndex(collection)}[*]`;
    const body = this.splatted({ type: 'Bound', value: [{ name: valueName }, ...this.parseSteps()], position });
    return { type: 'For', valueName, collection, body, splat: true, position };
  }

  private atSplat(): boolean {
    return this.check(TokenType.LBracket) && this.tokens[this.current + 1].type === TokenType.Star && this.tokens[this.current + 2].type === TokenType.RBracket;
  }

  private parseTerm(): AttributeValue {
    const position = this.peek().position;

    if (this.matchToken(TokenType.OQuote)) return this.parseString(position);
    if (this.matchToken(TokenType.OHeredoc)) return this.parseHeredoc(position);

    if (this.matchToken(TokenType.LBracket)) return this.nested(position, () => this.parseList(position));
    if (this.matchToken(TokenType.LBrace)) return this.nested(position, () => this.parseMap(position));
    if (this.matchToken(TokenType.LParen)) return this.nested(position, () => this.parseParenthesized());

    if (this.check(TokenType.Identifier)) return this.parseNamed(position);

    return this.parseLiteral(position);
  }

  private parseLiteral(position: Position): AttributeValue {
    if (this.matchToken(TokenType.Number)) return { type: 'Number', value: this.exactNumber(this.previous().value, position), position };
    if (this.matchToken(TokenType.Boolean)) return { type: 'Boolean', value: this.previous().value === 'true', position };
    if (this.matchToken(TokenType.Null)) return { type: 'Null', position };

    return this.error(`Unexpected value: ${this.peek().value}`);
  }

  private parseParenthesized(): AttributeValue {
    const value = this.parseValue();
    this.consume(TokenType.RParen, "Expect ')' after the value in parentheses.");

    return value;
  }

  private nested<T>(opening: Position, read: () => T): T {
    const outer = this.depth;
    this.enter(opening);
    try {
      return read();
    } finally {
      this.depth = outer;
    }
  }

  private enter(opening: Position): void {
    if (this.depth === MAX_NESTING) throw new ConfigError(`Nested more than ${MAX_NESTING} levels deep`, opening);

    this.depth++;
  }

  /** `-` before a number is part of it, so `-1e5000` is refused as written. */
  private parseNegative(position: Position): AttributeValue {
    if (!this.matchToken(TokenType.Number)) return this.nested(position, () => ({ type: 'Negate', value: this.parseUnary(), position }));

    return { type: 'Number', value: this.exactNumber(`-${this.previous().value}`, position), position };
  }

  private parseString(position: Position): AttributeValue {
    const parts: TemplatePart[] = [];

    while (!this.matchToken(TokenType.CQuote))
      if (this.matchToken(TokenType.QuotedLit)) parts.push(readEscapes(this.previous().value, this.previous().position));
      else parts.push(this.parseInterpolation());

    return this.template(parts, position);
  }

  /** Escapes are not decoded, except `$${`. */
  private parseHeredoc(position: Position): AttributeValue {
    const flush = this.previous().value.startsWith('<<-');
    const parts: TemplatePart[] = [];

    while (!this.matchToken(TokenType.CHeredoc))
      if (this.matchToken(TokenType.StringLit)) parts.push(this.previous().value);
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
    const opening = this.advance().position;
    if (this.check(TokenType.TemplateEnd)) return this.error("Expect a value inside '${'.");

    return this.nested(opening, () => {
      const value = this.parseValue();
      this.consume(TokenType.TemplateEnd, "Expect '}' after the value inside '${'.");

      return value;
    });
  }

  private plainText(quote: Token, what: string): Token {
    const text = this.matchToken(TokenType.QuotedLit) ? this.previous() : { type: TokenType.QuotedLit, value: '', position: this.peek().position };
    if (this.check(TokenType.TemplateInterp)) throw new ConfigError(`A ${what} is plain text; it cannot hold an interpolation`, quote.position);

    this.advance();
    return text;
  }

  private parseList(position: Position): AttributeValue {
    // `for.x` is a reference to a resource of type `for`.
    if (this.checkWord('for') && this.tokens[this.current + 1].type !== TokenType.Dot) return this.parseFor(position, TokenType.RBracket);

    const values: AttributeValue[] = [];
    while (!this.check(TokenType.RBracket) && !this.isAtEnd()) {
      values.push(this.parseValue());
      if (!this.matchToken(TokenType.Comma)) break;
    }
    this.consume(TokenType.RBracket, "Expect ']' after list.");
    return { type: 'List', value: values, position };
  }

  /** The names are bound in the key and the body only. */
  private parseFor(position: Position, closing: keyof typeof CLOSING): ForNode {
    this.advance();
    const names = this.parseForNames();
    if (!this.checkWord('in')) return this.error("Expect 'in' after the names in a for expression.");
    this.advance();

    const collection = this.parseValue();
    this.consume(TokenType.Colon, "Expect ':' after the collection in a for expression.");

    this.bound.push(...names.map((name) => name.value));
    const made = { ...(closing === TokenType.RBrace ? this.parseEntry() : { body: this.parseValue() }), ...this.parseForCondition() };
    this.bound.splice(-names.length);

    this.consume(closing, `Expect '${CLOSING[closing]}' after the for expression.`);
    const [keyName, valueName] = names.length === 2 ? names.map((name) => name.value) : [undefined, names[0].value];
    return { type: 'For', ...(keyName && { keyName }), valueName, collection, ...made, position };
  }

  private parseEntry(): Pick<ForNode, 'key' | 'body' | 'grouped'> {
    const key = this.parseValue();
    this.consume(TokenType.FatArrow, "Expect '=>' after the key in a for expression.");
    const body = this.parseValue();

    return { key, body, ...(this.matchToken(TokenType.Ellipsis) && { grouped: true }) };
  }

  private parseForCondition(): Pick<ForNode, 'condition'> {
    if (!this.checkWord('if')) return {};

    this.advance();
    return { condition: this.parseValue() };
  }

  private parseForNames(): Token[] {
    const names = [this.forName("Expect a name after 'for'.")];
    if (!this.matchToken(TokenType.Comma)) return names;

    const second = this.forName("Expect a name after ','.");
    if (second.value === names[0].value) throw new ConfigError('The key and the value of a for need names of their own', second.position);

    return [...names, second];
  }

  /** A for name shadows references that start with it, so it cannot be a reference prefix. */
  private forName(message: string): Token {
    const name = this.consume(TokenType.Identifier, message);
    if (RESERVED_TYPES.has(name.value)) throw new ConfigError(`"${name.value}" cannot name an item in a for: a reference reads "${name.value}." as something else`, name.position);
    if (this.bound.includes(name.value)) throw new ConfigError(`"${name.value}" is named by a for around this one already`, name.position);

    this.forNames.push(name);
    return name;
  }

  private parseMap(position: Position): AttributeValue {
    // `{ for = 1 }` is a map with a key named `for`.
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

  /** Escapes are decoded, so one key spelled two ways is still one key. */
  private stringKey(quote: Token): Token {
    const text = this.plainText(quote, 'map key');

    return { ...quote, value: readEscapes(text.value, text.position) };
  }

  // A duplicate would silently replace the first, and `__proto__` would set a prototype, not a key.
  private checkKey(entries: object, key: Token): void {
    if (key.value === '__proto__') throw new ConfigError('__proto__ cannot be a name', key.position);
    if (Object.hasOwn(entries, key.value)) throw new ConfigError(`${key.value} is set twice`, key.position);
  }

  private parseNamed(position: Position): ReferenceNode | CallNode | BoundNode {
    const name = this.advance().value;
    if (this.matchToken(TokenType.LParen)) return { type: 'Call', name, args: this.nested(position, () => this.parseArguments()), position };
    if (this.bound.includes(name)) return { type: 'Bound', value: [{ name }, ...this.parseSteps()], position };

    return { type: 'Reference', value: [{ name }, ...this.parseSteps()], position };
  }

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

    while (!this.atSplat() && this.matchToken(TokenType.Dot, TokenType.LBracket))
      steps.push(this.previous().type === TokenType.Dot ? { name: this.consume(TokenType.Identifier, 'Expect property name after dot.').value } : this.parseBracket());

    return steps;
  }

  /** A number or a string written alone is a key; any other value is read where the step is: `var.names[count.index + 1]`. */
  private parseBracket(): Step {
    const opening = this.previous().position;
    if (this.check(TokenType.RBracket)) return this.error("Expect a value inside '['.");

    const index = this.nested(opening, () => this.parseValue());
    this.consume(TokenType.RBracket, "Expect ']' after the index.");

    if (index.type === 'String') return { key: index.value };
    if (index.type === 'Number') return { key: this.index(index.value, index.position) };

    return { index, spelled: spellIndex(index) };
  }

  private index(number: ExactNumber, position: Position): number {
    const written = number.toString();
    if (!/^\d+$/.test(written) || !Number.isSafeInteger(Number(written))) throw new ConfigError(`An index is a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`, position);

    return Number(written);
  }

  private matchToken(...types: TokenType[]): boolean {
    for (const type of types)
      if (this.check(type)) {
        this.advance();
        return true;
      }
    return false;
  }

  /** Names end up in addresses, which split on dots, so a name must be an identifier. */
  private consumeName(message: string, word: 'name' | 'type' = 'name'): Token {
    const quote = this.consume(TokenType.OQuote, message);
    const token = { ...quote, value: this.plainText(quote, 'label').value };
    if (!isName(token.value)) throw new ConfigError(`Invalid ${word} "${token.value}": a ${word} ${NAME_RULE}.`, token.position);

    return token;
  }

  /** Same rule as a name, and it cannot be a reference prefix. */
  private consumeType(message: string): Token {
    const token = this.consumeName(message, 'type');
    if (RESERVED_TYPES.has(token.value)) throw new ConfigError(`"${token.value}" cannot be a type: a reference reads "${token.value}." as something else.`, token.position);

    return token;
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

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    return this.error(message);
  }

  private error(message: string): never {
    throw new ConfigError(message, this.peek().position);
  }

  /** A contextual keyword, like `for` and `in`. */
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

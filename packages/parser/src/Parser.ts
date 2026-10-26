import { Program, spell } from './ast';
import { decodeBlock, SCHEMA } from './blocks/schema';
import { BodyParser } from './BodyParser';
import { ConfigError } from './ConfigError';
import { ExpressionParser } from './ExpressionParser';
import { Lexer } from './Lexer';
import { Position } from './Position';
import { Token } from './tokens';
import { TokenStream } from './TokenStream';

/** Reads a file in two steps, as HCL does: the attributes and blocks as written, then what each block means. */
export class Parser {
  private readonly expressions: ExpressionParser;
  private readonly body: BodyParser;

  constructor(tokens: Token[]) {
    const stream = new TokenStream(tokens);
    this.expressions = new ExpressionParser(stream);
    this.body = new BodyParser(stream, this.expressions, SCHEMA);
  }

  /** One file's blocks; what holds across a module's files is checked by `parseModule`. */
  public parse(): Program {
    const program: Program = [];
    for (const block of this.body.blocks()) program.push(...decodeBlock(block));

    return program;
  }

  /** Every name a for in the file gave an item. */
  get forNames(): readonly Token[] {
    return this.expressions.forNames;
  }
}

export interface ModuleFile {
  file: string;
  content: string;
}

/** A duplicate would silently replace the first. Moves are told apart where every module's are read together. */
function checkDeclaredOnce(program: Program): void {
  const declared = new Map<string, Position>();

  for (const statement of program) {
    if (statement.type === 'Moved') continue;

    const label = spell(statement);
    const first = declared.get(label);
    if (first) throw new ConfigError(`${label} is declared twice, first on ${first.file} line ${first.line}`, statement.position);
    declared.set(label, statement.position);
  }
}

/** A for name that equals a resource type would shadow every reference to that type. */
function checkForNames(program: Program, forNames: Token[]): void {
  const types = new Set(program.flatMap((statement) => (statement.type === 'Resource' ? [statement.resourceType] : [])));
  const shadowing = forNames.find((name) => types.has(name.value));
  if (shadowing) throw new ConfigError(`"${shadowing.value}" cannot name an item in a for: a reference reads "${shadowing.value}." as a resource of that type`, shadowing.position);
}

/** A module's files read as one: a name is declared once across them, and a for name is checked against every file's resource types. */
export function parseModule(files: ModuleFile[]): Program {
  const parsers = files.map(({ file, content }) => new Parser(new Lexer(content, file).tokenize()));
  const program = parsers.flatMap((parser) => parser.parse());

  const forNames = parsers.flatMap((parser) => parser.forNames);

  checkDeclaredOnce(program);
  checkForNames(program, forNames);
  return program;
}

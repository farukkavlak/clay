import { Program, spell } from './ast';
import { decodeBlock, SCHEMA } from './blocks/schema';
import { BodyParser } from './BodyParser';
import { ConfigError } from './ConfigError';
import { ExpressionParser } from './ExpressionParser';
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

  public parse(): Program {
    const program: Program = [];
    const declared = new Set<string>();

    for (const block of this.body.blocks())
      for (const statement of decodeBlock(block)) {
        // A duplicate would silently replace the first. Moves are told apart where every module's are read together.
        const label = spell(statement);
        if (statement.type !== 'Moved' && declared.has(label)) throw new ConfigError(`${label} is declared twice`, statement.position);
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
}

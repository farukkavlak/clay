import { ModuleAddress } from '@clay/core';
import { AttributeValue, ConfigError, namedIn, ParsedReference, parseReference, Position, ProviderBlock, spell, Statement } from '@clay/parser';

import { withPlace } from '../place';
import { Queue } from '../Queue';

/** As a reference spells what a provider block may read on the way: `var.x`, `local.x`, `data.t.n`. */
function spelledStatement(stmt: Statement): string | undefined {
  if (stmt.type === 'Variable') return `var.${stmt.name}`;
  if (stmt.type === 'Local') return `local.${stmt.name}`;
  if (stmt.type === 'Data') return `data.${stmt.dataSourceType}.${stmt.name}`;

  return undefined;
}

/** What names a block: a resource, a module call, or one a provider block may read; nothing for `count`, `each` and the like. */
function spelledReference(reference: ParsedReference): { spelled: string; made: boolean } | undefined {
  if (reference.kind === 'variable') return { spelled: `var.${reference.name}`, made: false };
  if (reference.kind === 'local') return { spelled: `local.${reference.name}`, made: false };
  if (reference.kind === 'data') return { spelled: `data.${reference.type}.${reference.name}`, made: false };
  if (reference.kind === 'module') return { spelled: `module.${reference.module}`, made: true };
  if (reference.kind === 'resource') return { spelled: `${reference.type}.${reference.name}`, made: true };

  return undefined;
}

function valuesRead(stmt: Statement): (AttributeValue | undefined)[] {
  if (stmt.type === 'Provider') return Object.values(stmt.attributes);
  if (stmt.type === 'Local') return [stmt.value];
  if (stmt.type === 'Variable') return [stmt.attributes.default, ...(stmt.validations ?? []).flatMap(({ condition, errorMessage }) => [condition, errorMessage])];
  if (stmt.type === 'Data') return [stmt.count, stmt.forEach, ...Object.values(stmt.attributes), ...(stmt.dependsOn ?? [])];

  return [];
}

/** Each block the statement reads, where it is read. */
function readsOf(stmt: Statement): { spelled: string; made: boolean; position: Position }[] {
  const nodes = valuesRead(stmt).flatMap((value) => (value === undefined ? [] : namedIn(value)));

  return nodes.flatMap((node) => {
    const named = node.type === 'Reference' ? spelledReference(parseReference(node.value, node.position)) : undefined;
    return named ? [{ ...named, position: node.position }] : [];
  });
}

/** A statement reached, the ones passed through on the way, and where the provider block starts the way. */
interface Reached {
  stmt: Statement;
  through: string[];
  at?: Position;
}

/** A destroy configures a provider with no resource left to read, and a plan before the resources it makes. */
function refused(provider: ProviderBlock, read: string[], at: Position): ConfigError {
  const message = `${spell(provider)} reads ${read.join(' -> ')}, but a provider block reads no resource or module: it is configured before the resources it makes`;
  return withPlace(new ConfigError(message, at), at, spell(provider), ModuleAddress.root);
}

/** Marks in `kept` what the provider block reads, through any number of variables, locals and data sources. */
function follow(provider: ProviderBlock, readables: Map<string, Statement>, kept: Set<Statement>): void {
  const queue = new Queue<Reached>([{ stmt: provider, through: [] }]);
  kept.add(provider);

  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const { spelled, made, position } of readsOf(next.stmt)) {
      const at = next.at ?? position;
      if (made) throw refused(provider, [...next.through, spelled], at);

      // One not declared is refused where the graph is built, as any other reference to it.
      const stmt = readables.get(spelled);
      if (stmt === undefined || kept.has(stmt)) continue;

      kept.add(stmt);
      queue.push({ stmt, through: [...next.through, spelled], at });
    }
}

/**
 * The root module's provider blocks and what they read, in the order written, which is all a destroy needs. A provider block that reads a
 * resource or a module call, even through other values, is refused at the value it writes.
 */
export function providerSlice(program: Statement[]): Statement[] {
  const readables = new Map(
    program.flatMap((stmt) => {
      const spelled = spelledStatement(stmt);
      return spelled === undefined ? [] : [[spelled, stmt] as const];
    })
  );
  const kept = new Set<Statement>();

  for (const stmt of program) if (stmt.type === 'Provider') follow(stmt, readables, kept);

  return program.filter((stmt) => kept.has(stmt));
}

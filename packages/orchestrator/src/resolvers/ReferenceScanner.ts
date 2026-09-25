import { Address } from '@clay/contracts';
import { parseReference, Position } from '@clay/parser';
import { childScope, outputKey, scopeOf, variableKey } from '../keys';

/** Every AST node carries one, but this walks plain objects too, so a value of another shape is no position. */
function positionOf(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Position>;

  return typeof candidate.file === 'string' && typeof candidate.line === 'number' && typeof candidate.column === 'number' ? (candidate as Position) : undefined;
}

/** What a config value reads from, with the graph key it is addressed by, and where it was written. */
export type Reference = (
  | { kind: 'resource'; key: string; address: string }
  | { kind: 'variable'; key: string; name: string }
  | { kind: 'output'; key: string; scope: string; module: string; name: string }
) & { position?: Position };

export class ReferenceScanner {
  referencesIn(value: unknown, context: Address): Reference[] {
    const references: Reference[] = [];
    this.collect(value, context, references);
    return references;
  }

  private collect(value: unknown, context: Address, references: Reference[]): void {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) for (const item of value) this.collect(item, context, references);
    else this.collectFromObject(value as Record<string, unknown>, context, references);
  }

  private collectFromObject(obj: Record<string, unknown>, context: Address, references: Reference[]): void {
    const position = positionOf(obj.position);

    if (obj.type === 'Reference' && Array.isArray(obj.value)) this.addReference(obj.value as string[], context, references, position);
    else for (const item of Object.values(obj)) this.collect(item, context, references);
  }

  private addReference(refParts: string[], context: Address, references: Reference[], position?: Position): void {
    const reference = parseReference(refParts, position);
    const scope = scopeOf(context);

    // A data source is read where the config loads, so it is no node of its own.
    if (reference.kind === 'data') return;

    if (reference.kind === 'variable') references.push({ kind: 'variable', key: variableKey(scope, reference.name), name: reference.name, position });
    else if (reference.kind === 'module') {
      const child = childScope(scope, reference.module);
      references.push({ kind: 'output', key: outputKey(child, reference.output), scope: child, module: reference.module, name: reference.output, position });
    } else {
      const address = new Address(context.modulePath, reference.type, reference.name).toString();
      references.push({ kind: 'resource', key: address, address, position });
    }
  }
}

import { Address } from '@clay/contracts';
import { ParsedReference, parseReference, Position, ResourceReference, Step } from '@clay/parser';

import { Instances } from '../Instances';
import { childScope, outputKey, scopeOf, variableKey } from '../keys';

/** Every AST node carries one, but this walks plain objects too, so a value of another shape is no position. */
function positionOf(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Position>;

  return typeof candidate.file === 'string' && typeof candidate.line === 'number' && typeof candidate.column === 'number' ? (candidate as Position) : undefined;
}

/**
 * What a config value reads from, with the graph key it is addressed by, and where it was written.
 * A resource's key is its block, which every instance of it shares; its address names the instance read.
 */
export type Reference = (
  | { kind: 'resource'; key: string; address: string; reference: ResourceReference }
  | { kind: 'variable'; key: string; name: string }
  | { kind: 'output'; key: string; scope: string; module: string; name: string }
  | { kind: 'count' }
) & { position?: Position };

export class ReferenceScanner {
  constructor(private instances: Instances) {}

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

    if (obj.type === 'Reference' && Array.isArray(obj.value)) this.addReference(obj.value as Step[], context, references, position);
    else for (const item of Object.values(obj)) this.collect(item, context, references);
  }

  private addReference(refParts: Step[], context: Address, references: Reference[], position?: Position): void {
    const found = this.referenceOf(parseReference(refParts, position), context);
    if (found) references.push({ ...found, position });
  }

  private referenceOf(reference: ParsedReference, context: Address): Reference | undefined {
    const scope = scopeOf(context);

    switch (reference.kind) {
      // A data source is read where the config loads, so it is no node of its own.
      case 'data': {
        return undefined;
      }
      case 'count': {
        return { kind: 'count' };
      }
      case 'variable': {
        return { kind: 'variable', key: variableKey(scope, reference.name), name: reference.name };
      }
      case 'module': {
        const child = childScope(scope, reference.module);
        return { kind: 'output', key: outputKey(child, reference.output), scope: child, module: reference.module, name: reference.output };
      }
      default: {
        return { kind: 'resource', ...this.addressesOf(reference, context), reference };
      }
    }
  }

  /** The block, and the instance an index names on a block with count; whether the index is right is the graph's to say. */
  private addressesOf(reference: ResourceReference, context: Address): { key: string; address: string } {
    const block = new Address(context.modulePath, reference.type, reference.name);
    const [first] = reference.path;
    const key = this.instances.isCounted(block.toString()) && typeof first === 'number' ? first : undefined;

    return { key: block.toString(), address: new Address(block.modulePath, block.resourceType, block.name, key).toString() };
  }
}

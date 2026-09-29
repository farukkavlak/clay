import { Address } from '@clay/contracts';
import { ParsedReference, parseReference, Position, ResourceReference, Step } from '@clay/parser';

import { Instances, repetitionOfKey } from '../Instances';
import { Context, moduleOf, outputKey, scopeOf, variableKey } from '../keys';

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
  | { kind: 'each'; name: 'key' | 'value' }
) & { position?: Position };

export class ReferenceScanner {
  constructor(private instances: Instances) {}

  referencesIn(value: unknown, context: Context): Reference[] {
    const references: Reference[] = [];
    this.collect(value, context, references);
    return references;
  }

  private collect(value: unknown, context: Context, references: Reference[]): void {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) for (const item of value) this.collect(item, context, references);
    else this.collectFromObject(value as Record<string, unknown>, context, references);
  }

  private collectFromObject(obj: Record<string, unknown>, context: Context, references: Reference[]): void {
    const position = positionOf(obj.position);

    if (obj.type === 'Reference' && Array.isArray(obj.value)) this.addReference(obj.value as Step[], context, references, position);
    else for (const item of Object.values(obj)) this.collect(item, context, references);
  }

  private addReference(refParts: Step[], context: Context, references: Reference[], position?: Position): void {
    const found = this.referenceOf(parseReference(refParts, position), context);
    if (found) references.push({ ...found, position });
  }

  private referenceOf(reference: ParsedReference, context: Context): Reference | undefined {
    const scope = scopeOf(context);

    switch (reference.kind) {
      // A data source is read where the config loads, so it is no node of its own.
      case 'data': {
        return undefined;
      }
      case 'count': {
        return { kind: 'count' };
      }
      case 'each': {
        return { kind: 'each', name: reference.name };
      }
      case 'variable': {
        return { kind: 'variable', key: variableKey(scope, reference.name), name: reference.name };
      }
      case 'module': {
        const child = scopeOf(moduleOf(context).child(reference.module));
        return { kind: 'output', key: outputKey(child, reference.output), scope: child, module: reference.module, name: reference.output };
      }
      default: {
        return { kind: 'resource', ...this.addressesOf(reference, context), reference };
      }
    }
  }

  /** The block, and the instance a first step names on a block with count or for_each; whether the step is right is the graph's to say. */
  private addressesOf(reference: ResourceReference, context: Context): { key: string; address: string } {
    const block = new Address(moduleOf(context), reference.type, reference.name);
    const [first] = reference.path;
    const key = this.instances.repetitionOf(block.toString()) === repetitionOfKey(first) ? first : undefined;

    return { key: block.toString(), address: new Address(block.module, block.resourceType, block.name, key).toString() };
  }
}

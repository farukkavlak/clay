import { Address, InstanceKey, ModuleAddress } from '@clay/contracts';
import { ModuleOutputReference, ParsedReference, parseReference, Position, ResourceReference, Step, stepKey } from '@clay/parser';

import { repetitionOfKey } from '../Instances';
import { instanceKeyIn } from './instance';
import { ModuleInstances } from '../ModuleInstances';
import { blockKey, callKey, Context, moduleOf, outputKey, scopeOf, variableKey } from '../keys';

/** It also walks plain objects, which may have no position. */
function positionOf(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Position>;

  return typeof candidate.file === 'string' && typeof candidate.line === 'number' && typeof candidate.column === 'number' ? (candidate as Position) : undefined;
}

/**
 * A resource's `key` is its block in the graph, shared by every instance; `block` is that block in the module instance read from.
 * An output's `call` makes the instance read, and `instanceKey` is the index or key it is read at.
 * With no `name` it reads the whole module, and its `key` is the call, since the module may have no output.
 */
export type Reference = (
  | { kind: 'resource'; key: string; block: string; reference: ResourceReference }
  | { kind: 'variable'; key: string; name: string }
  | { kind: 'output'; key: string; call: ModuleAddress; instanceKey?: InstanceKey; scope: string; module: string; name?: string; reference: ModuleOutputReference }
  | { kind: 'count' }
  | { kind: 'each'; name: 'key' | 'value' }
) & { position?: Position };

export class ReferenceScanner {
  constructor(private modules: ModuleInstances) {}

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
      // Data sources and paths are known at load, so neither is a graph node.
      case 'data':
      case 'path': {
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
        return { kind: 'output', ...this.outputOf(reference, context) };
      }
      default: {
        return { kind: 'resource', ...this.addressesOf(reference, context), reference };
      }
    }
  }

  /** The graph checks the steps later, once it knows the module exists. */
  private outputOf(reference: ModuleOutputReference, context: Context): Omit<Extract<Reference, { kind: 'output' }>, 'kind' | 'position'> {
    const caller = moduleOf(context);
    const call = caller.child(reference.module);
    const first = instanceKeyIn(reference.path);
    const repetition = this.modules.repetitionOf(call.withoutKeys());
    const instanceKey = repetition === repetitionOfKey(first) ? first : undefined;
    const step = reference.path.at(instanceKey === undefined ? 0 : 1);
    const named = step && stepKey(step);
    const scope = scopeOf(call.withoutKeys());
    // A number where the output goes is refused once the graph knows the module exists.
    const output = named === undefined ? undefined : String(named);

    return {
      key: output === undefined ? callKey(call.withoutKeys()) : outputKey(scope, output),
      call,
      ...(instanceKey !== undefined && { instanceKey }),
      scope,
      module: reference.module,
      ...(output !== undefined && { name: output }),
      reference,
    };
  }

  /** The graph checks the steps later. */
  private addressesOf(reference: ResourceReference, context: Context): { key: string; block: string } {
    const block = new Address(moduleOf(context), reference.type, reference.name);

    return { key: blockKey(block), block: block.toString() };
  }
}

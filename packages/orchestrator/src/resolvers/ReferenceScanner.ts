import { Address, InstanceKey, ModuleAddress } from '@clay/contracts';
import { ModuleOutputReference, ParsedReference, parseReference, Position, ResourceReference, Step } from '@clay/parser';

import { Instances, repetitionOfKey } from '../Instances';
import { ModuleInstances } from '../ModuleInstances';
import { blockKey, Context, moduleOf, outputKey, scopeOf, variableKey } from '../keys';

/** Every AST node carries one, but this walks plain objects too, so a value of another shape is no position. */
function positionOf(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Position>;

  return typeof candidate.file === 'string' && typeof candidate.line === 'number' && typeof candidate.column === 'number' ? (candidate as Position) : undefined;
}

/**
 * What a config value reads from, with the key it is addressed by, and where it was written: read in an instance of a module, a variable or an output is keyed in that instance.
 * A resource's key is its block in the graph, which every instance of it shares; `block` is that block in the module instance read from, and `address` names the instance read.
 * An output's key is its node in the graph; `address` is the output of the instance read, and `call` the call that makes that instance, with `instanceKey` the index or key it is read at.
 */
export type Reference = (
  | { kind: 'resource'; key: string; block: string; address: string; reference: ResourceReference }
  | { kind: 'variable'; key: string; name: string }
  | { kind: 'output'; key: string; address: string; call: ModuleAddress; instanceKey?: InstanceKey; scope: string; module: string; name: string; reference: ModuleOutputReference }
  | { kind: 'count' }
  | { kind: 'each'; name: 'key' | 'value' }
) & { position?: Position };

export class ReferenceScanner {
  constructor(
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

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
        return { kind: 'output', ...this.outputOf(reference, context) };
      }
      default: {
        return { kind: 'resource', ...this.addressesOf(reference, context), reference };
      }
    }
  }

  /** The output, and the instance a first step names on a call with count or for_each; whether the steps are right is the graph's to say, once it knows the module is there. */
  private outputOf(reference: ModuleOutputReference, context: Context): Omit<Extract<Reference, { kind: 'output' }>, 'kind' | 'position'> {
    const caller = moduleOf(context);
    const call = caller.child(reference.module);
    const [first, second] = reference.path;
    const repetition = this.modules.repetitionOf(call.withoutKeys());
    const instanceKey = repetition === repetitionOfKey(first) ? first : undefined;
    const named = instanceKey === undefined ? first : second;
    const output = typeof named === 'string' ? named : '';
    const scope = scopeOf(call.withoutKeys());

    return {
      key: outputKey(scope, output),
      address: outputKey(scopeOf(caller.child(reference.module, instanceKey)), output),
      call,
      ...(instanceKey !== undefined && { instanceKey }),
      scope,
      module: reference.module,
      name: output,
      reference,
    };
  }

  /** The block, and the instance a first step names on a block with count or for_each; whether the step is right is the graph's to say. */
  private addressesOf(reference: ResourceReference, context: Context): { key: string; block: string; address: string } {
    const block = new Address(moduleOf(context), reference.type, reference.name);
    const key = blockKey(block);
    const [first] = reference.path;
    const instance = this.instances.repetitionOf(key) === repetitionOfKey(first) ? first : undefined;

    return { key, block: block.toString(), address: new Address(block.module, block.resourceType, block.name, instance).toString() };
  }
}

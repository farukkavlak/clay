import { Address, Schema, Type, types } from '@clay/contracts';
import { CountReference, EachReference, ModuleOutputReference, Position, ResourceReference, Step, VariableReference } from '@clay/parser';

import { Instances } from '../Instances';
import { blockKey, Context, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { placed } from '../place';
import { ScopeManager } from '../scope/ScopeManager';
import { everyOf, everyType, instanceType, noAttribute, outputsType, readCall, readInstance } from './instance';

/** Data sources and paths are known at load, so they are not here. */
type Unread = VariableReference | ModuleOutputReference | ResourceReference | CountReference | EachReference;

/** Types for references read as written, before any instance exists. */
export class WrittenTypes {
  constructor(
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  typeOf(reference: Unread, where: Context, position: Position): { type: Type; path: Step[] } {
    const module = moduleOf(where);

    // The graph has already refused undeclared variables.
    if (reference.kind === 'variable') return { type: this.scopeManager.getVariable(scopeOf(module), reference.name)!.type ?? types.dynamic, path: reference.path };
    if (reference.kind === 'count') return { type: types.number, path: reference.path };
    if (reference.kind === 'each') return { type: reference.name === 'key' ? types.string : types.dynamic, path: reference.path };
    if (reference.kind === 'module') return this.callType(reference, where, position);

    return this.resourceType(reference, where, position);
  }

  /** An output that names no type is `dynamic`. */
  private callType(reference: ModuleOutputReference, where: Context, position: Position): { type: Type; path: Step[] } {
    const call = moduleOf(where).child(reference.module).withoutKeys();
    const { every, output, path } = readCall(reference, this.modules.repetitionOf(call), position);
    const outputs = this.scopeManager.outputsOf(scopeOf(call));
    if (every) return { type: everyOf(every, outputsType(outputs)), path };

    // The graph has already refused undeclared outputs.
    return { type: output === undefined ? outputsType(outputs) : outputs.get(output)!, path };
  }

  /** The type of the attribute, of the whole instance where the reference names none, or of every instance where it names no instance. */
  private resourceType(reference: ResourceReference, where: Context, position: Position): { type: Type; path: Step[] } {
    const block = blockKey(new Address(moduleOf(where), reference.type, reference.name));
    const { every, attribute, path } = readInstance(reference, this.instances.repetitionOf(block), position);
    // Every schema is loaded by now.
    const schema = this.schemas.get(reference.type)!;
    if (every) return { type: everyType(every, schema), path };
    if (attribute === undefined) return { type: instanceType(schema), path };
    if (!Object.hasOwn(schema, attribute)) throw placed(noAttribute(reference.type, attribute), position);

    return { type: schema[attribute].type, path };
  }
}

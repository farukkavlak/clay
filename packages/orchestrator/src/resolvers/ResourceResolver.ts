import { Address, Schema, State, UNKNOWN } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { blockKey, Context, moduleOf } from '../keys';
import { placed } from '../place';
import { Planned, PlannedInstance } from '../Planned';
import { TypeMismatch, typedValues } from '../typed';
import { objectOf, plainOf, Value, valueOf } from '../Value';
import { everyType, noAttribute, readInstance } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** A name only the apply sets is unknown; any other unplanned name is null. Names outside the schema were refused earlier. */
function plannedAttribute(instance: PlannedInstance, name: string): unknown {
  if (Object.hasOwn(instance.known, name)) return instance.known[name];

  return instance.later.has(name) ? UNKNOWN : null;
}

function notFound(spelled: string, address: Address): string {
  return `Invalid resource reference "${spelled}": Resource "${address.toString()}" not found in state`;
}

export class ResourceResolver {
  constructor(
    private instances: Instances,
    private planned: Planned,
    private schemas: Map<string, Schema>
  ) {}

  /** Returns the attribute and the steps still to take into it, the whole instance where the reference names no attribute, or every instance where it names no instance. */
  resolve(reference: ResourceReference, context: Context, state: State, position?: Position): { value: Value; path: Step[] } {
    const schema = this.schemas.get(reference.type) ?? {};
    const block = new Address(moduleOf(context), reference.type, reference.name);
    const { every, key, attribute, path } = readInstance(reference, this.instances.repetitionOf(blockKey(block)), position);
    if (every) return { value: this.every(reference, block, every, schema, state, position), path };

    const address = new Address(block.module, reference.type, reference.name, key);
    const attributeOf = this.attributesOf(address, reference.type, schema, state, position);
    const spelled = spellReference([{ name: reference.type }, { name: reference.name }, ...reference.path.slice(0, reference.path.length - path.length)]);
    if (!attributeOf) throw new UnresolvedReferenceError(notFound(spelled, address));

    const values = this.typedRead(reference, attribute === undefined ? Object.keys(schema) : [attribute], attributeOf, schema, position);
    return { value: attribute === undefined ? objectOf(Object.entries(values)) : values[attribute], path };
  }

  /** Not known until its count or for_each is read and each instance is planned or in state; its type is known before then. */
  private every(reference: ResourceReference, block: Address, repetition: Repetition, schema: Schema, state: State, position?: Position): Value {
    const type = everyType(repetition, schema);
    const keys = this.instances.keysOf(block.toString());
    const spelled = spellReference([{ name: reference.type }, { name: reference.name }]);
    if (keys === undefined) throw new UnresolvedReferenceError(`${spelled} is known only once its ${repetition} is read`, type);

    const instances = keys.map((key) => {
      const address = new Address(block.module, reference.type, reference.name, key);
      const attributeOf = this.attributesOf(address, reference.type, schema, state, position);
      if (!attributeOf) throw new UnresolvedReferenceError(notFound(spelled, address), type);

      return plainOf(this.typedRead(reference, Object.keys(schema), attributeOf, schema, position));
    });

    return valueOf(type, repetition === 'count' ? instances : Object.fromEntries(keys.map((key, index) => [key, instances[index]])));
  }

  /** An instance the plan creates or changes is read from the plan, not state. Undefined where neither has it. */
  private attributesOf(address: Address, type: string, schema: Schema, state: State, position?: Position): ((name: string) => unknown) | undefined {
    const planned = this.planned.get(address.toString());
    if (planned) return (name) => plannedAttribute(planned, name);

    const resource = state.resources[address.toString()];
    return resource && ((name) => this.getResolvedAttribute(resource, type, schema, name, position));
  }

  private typedRead(reference: ResourceReference, names: string[], attributeOf: (name: string) => unknown, schema: Schema, position?: Position): Record<string, Value> {
    try {
      return typedValues(schema, Object.fromEntries(names.map((name) => [name, attributeOf(name)])));
    } catch (error) {
      if (!(error instanceof TypeMismatch)) throw error;
      throw placed(`${reference.type}.${reference.name} holds what its schema does not: ${error.message}`, position);
    }
  }

  /** A schema attribute missing from state is null; any other name is refused. */
  private getResolvedAttribute(resource: { attributes: Record<string, unknown> }, type: string, schema: Schema, attributeName: string, position?: Position): unknown {
    // Plain indexing would find inherited names like `toString`.
    if (Object.hasOwn(resource.attributes, attributeName)) return resource.attributes[attributeName];
    if (Object.hasOwn(schema, attributeName)) return null;

    throw placed(noAttribute(type, attributeName), position);
  }
}

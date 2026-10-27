import { Address, AttributePath, InstanceKey, Schema, sensitiveUnder, State, UNKNOWN } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances, Repetition } from '../../instances/Instances';
import { blockKey, Context, moduleOf } from '../../keys';
import { placed } from '../../place';
import { Planned, PlannedInstance } from '../../values/Planned';
import { Versions } from '../../values/Versions';
import { TypeMismatch, typedValues } from '../../values/typed';
import { objectOf, sensitiveOf, Value, valueOf, withSensitive } from '../../values/Value';
import { everyType, noAttribute, readInstance } from './instance';
import { UnresolvedReferenceError } from '../UnresolvedReferenceError';

/** A name only the apply sets is unknown; any other unplanned name is null. Names outside the schema were refused earlier. */
function plannedAttribute(instance: PlannedInstance, name: string): unknown {
  if (Object.hasOwn(instance.known, name)) return instance.known[name];

  return instance.later.has(name) ? UNKNOWN : null;
}

/** An instance as the plan or the state holds it, with the steps to each sensitive part. */
interface Held {
  attribute: (name: string) => unknown;
  sensitive: readonly AttributePath[] | undefined;
  /** Replaced as a whole, never changed inside, when the instance comes to other values. */
  values: object;
}

/** Every instance of a block, as built from its keys and the state it was read in, until one of its instances is written. */
interface EveryRead {
  keys: readonly InstanceKey[];
  state: State;
  version: number;
  value: Value;
}

/** Attributes read from one instance's values while it has the same sensitive parts. */
interface InstanceRead {
  sensitive: readonly AttributePath[] | undefined;
  attributes: Map<string, Value>;
}

function spelledBlock(reference: ResourceReference): string {
  return spellReference([{ name: reference.type }, { name: reference.name }]);
}

function notFound(spelled: string, address: Address): string {
  return `Invalid resource reference "${spelled}": Resource "${address.toString()}" not found in state`;
}

export class ResourceResolver {
  /** A read types the whole attribute, so a value read for each of its keys would be typed again for each. */
  private reads = new WeakMap<object, InstanceRead>();
  /** Built from every instance, so a value built for each reader would make n readers of n instances take n². */
  private everyReads = new Map<string, EveryRead>();

  constructor(
    private instances: Instances,
    private planned: Planned,
    private schemas: Map<string, Schema>,
    private versions: Versions
  ) {}

  /** Returns the attribute and the steps still to take into it, the whole instance where the reference names no attribute, or every instance where it names no instance. */
  resolve(reference: ResourceReference, context: Context, state: State, position?: Position): { value: Value; path: Step[] } {
    const schema = this.schemas.get(reference.type) ?? {};
    const block = new Address(moduleOf(context), reference.type, reference.name);
    const { every, key, attribute, path } = readInstance(`${reference.type}.${reference.name}`, reference.path, this.instances.repetitionOf(blockKey(block)), position);
    if (every) return { value: this.every(reference, block, every, schema, state, position), path };

    const address = new Address(block.module, reference.type, reference.name, key);
    const held = this.heldAt(address, reference.type, schema, state, position);
    const spelled = spellReference([{ name: reference.type }, { name: reference.name }, ...reference.path.slice(0, reference.path.length - path.length)]);
    if (!held) throw new UnresolvedReferenceError(notFound(spelled, address));

    const values = this.typedRead(reference, attribute === undefined ? Object.keys(schema) : [attribute], held, schema, position);
    return { value: attribute === undefined ? objectOf(Object.entries(values)) : values[attribute], path };
  }

  /** Not known until its count or for_each is read and each instance is planned or in state; its type is known before then. */
  private every(reference: ResourceReference, block: Address, repetition: Repetition, schema: Schema, state: State, position?: Position): Value {
    const at = block.toString();
    const keys = this.instances.keysOf(at);
    if (keys === undefined) throw new UnresolvedReferenceError(`${spelledBlock(reference)} is known only once its ${repetition} is read`, everyType(repetition, schema));

    const version = this.versions.of(at);
    const read = this.everyReads.get(at);
    if (read && read.keys === keys && read.state === state && read.version === version) return read.value;

    const value = this.built(reference, block, repetition, keys, schema, state, position);
    this.everyReads.set(at, { keys, state, version, value });
    return value;
  }

  private built(reference: ResourceReference, block: Address, repetition: Repetition, keys: InstanceKey[], schema: Schema, state: State, position?: Position): Value {
    const type = everyType(repetition, schema);
    const spelled = spelledBlock(reference);
    const instances = keys.map((key): [InstanceKey, Value] => {
      const address = new Address(block.module, reference.type, reference.name, key);
      const held = this.heldAt(address, reference.type, schema, state, position);
      if (!held) throw new UnresolvedReferenceError(notFound(spelled, address), type);

      return [key, objectOf(Object.entries(this.typedRead(reference, Object.keys(schema), held, schema, position)))];
    });
    const data = instances.map(([, instance]) => instance.data);
    const sensitive = instances.flatMap(([key, instance]) => sensitiveOf(instance).map((path) => [key, ...path]));

    return withSensitive(valueOf(type, repetition === 'count' ? data : Object.fromEntries(keys.map((key, index) => [key, data[index]]))), sensitive);
  }

  /** An instance the plan creates or changes is read from the plan, not state. Undefined where neither has it. */
  private heldAt(address: Address, type: string, schema: Schema, state: State, position?: Position): Held | undefined {
    const planned = this.planned.get(address.toString());
    if (planned) return { attribute: (name) => plannedAttribute(planned, name), sensitive: planned.sensitive, values: planned };

    const resource = state.resources[address.toString()];
    return resource && { attribute: (name) => this.getResolvedAttribute(resource, type, schema, name, position), sensitive: resource.sensitive, values: resource.attributes };
  }

  private typedRead(reference: ResourceReference, names: string[], held: Held, schema: Schema, position?: Position): Record<string, Value> {
    const { attributes } = this.readOf(held);
    const unread = names.filter((name) => !attributes.has(name));
    if (unread.length > 0) for (const [name, value] of Object.entries(this.typed(reference, unread, held, schema, position))) attributes.set(name, value);

    return Object.fromEntries(
      names.flatMap((name): [string, Value][] => {
        const value = attributes.get(name);
        return value ? [[name, value]] : [];
      })
    );
  }

  private readOf({ sensitive, values }: Held): InstanceRead {
    const read = this.reads.get(values);
    if (read && read.sensitive === sensitive) return read;

    const fresh = { sensitive, attributes: new Map<string, Value>() };
    this.reads.set(values, fresh);
    return fresh;
  }

  private typed(reference: ResourceReference, names: string[], { attribute, sensitive = [] }: Held, schema: Schema, position?: Position): Record<string, Value> {
    try {
      const values = typedValues(schema, Object.fromEntries(names.map((name) => [name, attribute(name)])));

      return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, withSensitive(value, sensitiveUnder(sensitive, name))]));
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

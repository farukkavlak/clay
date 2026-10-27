import { InstanceKey, Schema, Type } from '@clay/contracts';
import { DataReference, Position, Step } from '@clay/parser';

import { Instances, Repetition } from '../../instances/Instances';
import { Context, dataSourceAddress, dataSourceKey, moduleOf, scopeOf } from '../../keys';
import { objectOf, sensitiveOf, Value, valueOf, withSensitive } from '../../values/Value';
import { Versions } from '../../values/Versions';
import { everyType, readInstance } from './instance';
import { UnresolvedReferenceError } from '../UnresolvedReferenceError';

/** Every instance of a block, as built from its keys, until one of its instances is read again. */
interface EveryRead {
  keys: readonly InstanceKey[];
  version: number;
  value: Value;
}

export class DataSourceResolver {
  /** Built from every instance, so a value built for each reader would make n readers of n instances take n². */
  private everyReads = new Map<string, EveryRead>();

  constructor(
    private dataSources: Map<string, Record<string, Value>>,
    // Loaded with the configuration, before any data source is read.
    private dataSchemas: Map<string, Schema>,
    private instances: Instances,
    private versions: Versions
  ) {}

  /** Returns the attribute and the steps still to take into it, the whole instance where the reference names no attribute, or every instance where it names no instance. */
  resolve(reference: DataReference, context: Context, position?: Position): { value: Value; path: Step[] } {
    const module = moduleOf(context);
    // No scope: the error's place names the module.
    const spelled = `data.${reference.type}.${reference.name}`;
    const repetition = this.instances.repetitionOf(dataSourceKey(scopeOf(module.withoutKeys()), reference.type, reference.name));
    const { every, key, attribute, path } = readInstance(spelled, reference.path, repetition, position);
    if (every) return { value: this.every(reference, scopeOf(module), every, spelled), path };

    if (repetition && this.keysOf(reference, scopeOf(module)) === undefined) throw new UnresolvedReferenceError(`${spelled} is known only once its ${repetition} is read`);

    const dataAttributes = this.read(reference, scopeOf(module), key, spelled);
    if (attribute === undefined) return { value: objectOf(Object.entries(dataAttributes)), path };

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attribute) ? dataAttributes[attribute] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attribute}" not found on data source "${spelled}"`);

    return { value: attrValue, path };
  }

  /** Not known until its count or for_each is; its type is known before then. */
  private every(reference: DataReference, scope: string, repetition: Repetition, spelled: string): Value {
    // The graph has already refused undeclared data sources, and every one has its schema.
    const type = everyType(repetition, this.dataSchemas.get(reference.type)!);
    const at = dataSourceKey(scope, reference.type, reference.name);
    const keys = this.instances.keysOf(at);
    if (keys === undefined) throw new UnresolvedReferenceError(`${spelled} is known only once its ${repetition} is read`, type);

    const version = this.versions.of(at);
    const read = this.everyReads.get(at);
    if (read && read.keys === keys && read.version === version) return read.value;

    const value = this.built(reference, scope, repetition, keys, type, spelled);
    this.everyReads.set(at, { keys, version, value });
    return value;
  }

  private built(reference: DataReference, scope: string, repetition: Repetition, keys: InstanceKey[], type: Type, spelled: string): Value {
    const instances = keys.map((key) => objectOf(Object.entries(this.read(reference, scope, key, spelled))));
    const data = instances.map((instance) => instance.data);
    const sensitive = instances.flatMap((instance, index) => sensitiveOf(instance).map((path) => [keys[index], ...path]));

    return withSensitive(valueOf(type, repetition === 'count' ? data : Object.fromEntries(keys.map((key, index) => [key, data[index]]))), sensitive);
  }

  private keysOf(reference: DataReference, scope: string): InstanceKey[] | undefined {
    return this.instances.keysOf(dataSourceKey(scope, reference.type, reference.name));
  }

  private read(reference: DataReference, scope: string, key: InstanceKey | undefined, spelled: string): Record<string, Value> {
    const values = this.dataSources.get(dataSourceAddress(scope, reference.type, reference.name, key));
    if (!values) throw new Error(`Data source "${spelled}" not found (or not resolved yet)`);

    return values;
  }
}

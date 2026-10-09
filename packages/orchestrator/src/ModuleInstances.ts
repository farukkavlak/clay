import { InstanceKey, ModuleAddress } from '@clay/contracts';
import { AttributeValue, ModuleBlock } from '@clay/parser';

import { countFrom, indexesOf } from './count';
import { eachFrom } from './forEach';
import { Repetition } from './Instances';
import { Value } from './Value';

/** Undefined where only an apply knows the value. */
export type ReadIn = <T>(value: AttributeValue, parse: (value: Value) => T, caller: ModuleAddress) => T | undefined;

/** The keys of a call whose count or for_each only an apply knows: it makes no instance, and its keys stay unset. */
export const LATER = 'later';

function indexesOrLater(count: number | undefined): InstanceKey[] | typeof LATER {
  return count === undefined ? LATER : indexesOf(count);
}

/** Each module has one instance per instance of its caller, or one per key its call gives there. */
export class ModuleInstances {
  private repetitions = new Map<string, Repetition>();
  private instances = new Map<string, ModuleAddress[]>();
  private keys = new Map<string, InstanceKey[]>();
  private values = new Map<string, Map<string, Value>>();

  clear(): void {
    this.repetitions.clear();
    this.instances.clear();
    this.keys.clear();
    this.values.clear();
  }

  declare(module: ModuleAddress, repetition: Repetition): void {
    this.repetitions.set(module.toString(), repetition);
  }

  repetitionOf(module: ModuleAddress): Repetition | undefined {
    return this.repetitions.get(module.toString());
  }

  /** `keysIn` returns undefined for a call with neither count nor for_each. */
  expand(caller: ModuleAddress, name: string, keysIn: (instance: ModuleAddress) => InstanceKey[] | typeof LATER | undefined): void {
    const made = this.of(caller).flatMap((instance) => {
      const keys = keysIn(instance);
      if (keys === undefined) return [instance.child(name)];
      if (keys === LATER) return [];

      this.keys.set(instance.child(name).toString(), keys);
      return keys.map((key) => instance.child(name, key));
    });

    this.instances.set(caller.child(name).toString(), made);
  }

  expandCall(caller: ModuleAddress, block: ModuleBlock, read: ReadIn): void {
    const { count, forEach } = block;

    this.expand(caller, block.name, (instance) => {
      if (count) return indexesOrLater(read(count, countFrom, instance));

      return forEach ? this.eachKeys(instance.child(block.name), read(forEach, eachFrom, instance)) : undefined;
    });
  }

  private eachKeys(call: ModuleAddress, values: Map<string, Value> | undefined): InstanceKey[] | typeof LATER {
    if (values === undefined) return LATER;

    this.values.set(call.toString(), values);
    return [...values.keys()];
  }

  /** The graph runs a module's call before anything in it, so its instances already exist. */
  of(module: ModuleAddress): ModuleAddress[] {
    if (module.isRoot()) return [module];

    return this.instances.get(module.toString())!;
  }

  /** `call` is the call in one caller instance, as `module.a[1].module.b`. */
  keysOf(call: ModuleAddress): InstanceKey[] | undefined {
    return this.keys.get(call.toString());
  }

  eachValue(call: ModuleAddress, key: string): Value | undefined {
    return this.values.get(call.toString())?.get(key);
  }
}

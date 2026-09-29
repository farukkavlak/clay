import { InstanceKey, ModuleAddress } from '@clay/contracts';
import { AttributeValue, ModuleBlock } from '@clay/parser';

import { countFrom, indexesOf } from './count';
import { eachFrom } from './forEach';
import { Repetition } from './Instances';

/** Reads a call's count or for_each in one instance of the module that calls it, and parses what it reads. */
export type ReadIn = <T>(value: AttributeValue, parse: (value: unknown) => T, caller: ModuleAddress) => T;

/**
 * Which modules are called with count or for_each, by the module as the configuration writes it, and the instances of each once its call has run.
 * The root has one instance; a module has one for each instance of the module that calls it, or one per key its call gives there.
 */
export class ModuleInstances {
  private repetitions = new Map<string, Repetition>();
  private instances = new Map<string, ModuleAddress[]>();
  private keys = new Map<string, InstanceKey[]>();
  private values = new Map<string, Map<string, unknown>>();

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

  /** `keysIn` reads the call in one instance of the module that calls it, and gives nothing for a call with neither count nor for_each. */
  expand(caller: ModuleAddress, name: string, keysIn: (instance: ModuleAddress) => InstanceKey[] | undefined): void {
    const made = this.of(caller).flatMap((instance) => {
      const keys = keysIn(instance);
      if (keys === undefined) return [instance.child(name)];

      this.keys.set(instance.child(name).toString(), keys);
      return keys.map((key) => instance.child(name, key));
    });

    this.instances.set(caller.child(name).toString(), made);
  }

  /** Makes the instances a call's count or for_each gives in each instance of the module that calls it, keeping the value for_each gives each. */
  expandCall(caller: ModuleAddress, block: ModuleBlock, read: ReadIn): void {
    const { count, forEach } = block;

    this.expand(caller, block.name, (instance) => {
      if (!forEach) return count ? indexesOf(read(count, countFrom, instance)) : undefined;

      const values = read(forEach, eachFrom, instance);
      this.values.set(instance.child(block.name).toString(), values);
      return [...values.keys()];
    });
  }

  /** A graph runs a module's call before anything in it, so a module asked for has had its instances made. */
  of(module: ModuleAddress): ModuleAddress[] {
    if (module.isRoot()) return [module];

    return this.instances.get(module.toString())!;
  }

  /** The keys a call gives in one instance of the module that calls it, named as `module.a[1].module.b`; nothing for a call with neither count nor for_each. */
  keysOf(call: ModuleAddress): InstanceKey[] | undefined {
    return this.keys.get(call.toString());
  }

  /** The value for_each gives the instance `key` of a call, read as `each.value` in its inputs. */
  eachValue(call: ModuleAddress, key: string): unknown {
    return this.values.get(call.toString())?.get(key);
  }
}

import { InstanceKey, ModuleAddress, Type } from '@clay/contracts';
import { ModuleOutputReference, Position, spellReference, Step } from '@clay/parser';

import { Repetition } from '../../instances/Instances';
import { callKey, Context, moduleOf, scopeOf } from '../../keys';
import { ModuleInstances } from '../../instances/ModuleInstances';
import { placed } from '../../place';
import { ScopeManager } from '../../config/ScopeManager';
import { convertedLater, joinedLater, laterOf, unjoined, Unjoinable } from '../../values/unify';
import { mayBeSensitive, objectOf, tupleOf, Value } from '../../values/Value';
import { Versions } from '../../values/Versions';
import { everyOf, outputsType, readCall } from './instance';
import { UnresolvedReferenceError } from '../UnresolvedReferenceError';

/** Every instance of a module call, as built from its keys, until one of its outputs is written. */
interface EveryRead {
  keys: readonly InstanceKey[];
  version: number;
  value: Value;
}

export class ModuleOutputResolver {
  /** Built from every instance, so a value built for each reader would make n readers of n instances take n². */
  private everyReads = new Map<string, EveryRead>();

  constructor(
    private scopeManager: ScopeManager,
    private modules: ModuleInstances,
    private versions: Versions
  ) {}

  /** Returns the output and the steps still to take into it, the whole instance where the reference names no output, or every instance where it names no instance. */
  resolve(reference: ModuleOutputReference, context: Context, position?: Position): { value: Value; path: Step[] } {
    const caller = moduleOf(context);
    const { every, key, output, path } = readCall(reference, this.modules.repetitionOf(caller.child(reference.module).withoutKeys()), position);
    if (every) return { value: this.every(reference, caller, every, position), path };

    const instance = caller.child(reference.module, key);
    return { value: output === undefined ? this.whole(instance) : this.output(instance, output), path };
  }

  private output(instance: ModuleAddress, name: string): Value {
    const value = this.scopeManager.getOutput(scopeOf(instance), name);
    if (value === undefined) throw new UnresolvedReferenceError(`Output "${name}" not found in module "${scopeOf(instance)}"`);

    return value;
  }

  private whole(instance: ModuleAddress): Value {
    return objectOf([...this.scopeManager.outputsOf(scopeOf(instance.withoutKeys())).keys()].map((name) => [name, this.output(instance, name)]));
  }

  private every(reference: ModuleOutputReference, caller: ModuleAddress, repetition: Repetition, position?: Position): Value {
    const call = caller.child(reference.module);
    const written = outputsType(this.scopeManager.outputsOf(scopeOf(call.withoutKeys())));
    const spelled = spellReference([{ name: 'module' }, { name: reference.module }]);
    const keys = this.modules.keysOf(call);
    if (keys === undefined) throw new UnresolvedReferenceError(`${spelled} is known only once its ${repetition} is read`, everyOf(repetition, written));

    const at = callKey(call);
    const version = this.versions.of(at);
    const read = this.everyReads.get(at);
    if (read && read.keys === keys && read.version === version) return read.value;

    const value = this.built(caller, reference, repetition, keys, written, spelled, position);
    this.everyReads.set(at, { keys, version, value });
    return value;
  }

  /** Converted as `tolist` converts, so outputs that take no one type are refused at the reference. */
  private built(caller: ModuleAddress, reference: ModuleOutputReference, repetition: Repetition, keys: InstanceKey[], written: Type, spelled: string, position?: Position): Value {
    const instances = keys.map((key) => this.whole(caller.child(reference.module, key)));
    const value = repetition === 'count' ? tupleOf(instances) : objectOf(keys.map((key, index) => [String(key), instances[index]]));

    try {
      return convertedLater(spelled, value, everyOf(repetition, joinedLater([written, ...instances.map((instance) => laterOf(instance))])), []);
    } catch (error) {
      if (!(error instanceof Unjoinable)) throw error;
      throw placed(`${spelled} ${unjoined(error, mayBeSensitive(value))}`, position);
    }
  }
}

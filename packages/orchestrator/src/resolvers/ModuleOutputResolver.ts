import { ModuleAddress } from '@clay/contracts';
import { ModuleOutputReference, Position, spellReference, Step } from '@clay/parser';

import { converted } from '../conformValues';
import { Repetition } from '../Instances';
import { Context, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { placed } from '../place';
import { ScopeManager } from '../scope/ScopeManager';
import { unified, Unjoinable } from '../unify';
import { objectOf, tupleOf, Value } from '../Value';
import { everyOf, outputsType, readCall } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver {
  constructor(
    private scopeManager: ScopeManager,
    private modules: ModuleInstances
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

  /** Converted as `tolist` converts, so outputs that take no one type are refused at the reference. */
  private every(reference: ModuleOutputReference, caller: ModuleAddress, repetition: Repetition, position?: Position): Value {
    const call = caller.child(reference.module);
    const written = outputsType(this.scopeManager.outputsOf(scopeOf(call.withoutKeys())));
    const spelled = spellReference([{ name: 'module' }, { name: reference.module }]);
    // A call's count and for_each are known at plan, and the reader runs after the call.
    const keys = this.modules.keysOf(call)!;

    const instances = keys.map((key) => this.whole(caller.child(reference.module, key)));
    const value = repetition === 'count' ? tupleOf(instances) : objectOf(keys.map((key, index) => [String(key), instances[index]]));

    try {
      return converted(spelled, value, everyOf(repetition, unified([written, ...instances.map((instance) => instance.type)])), []);
    } catch (error) {
      if (!(error instanceof Unjoinable)) throw error;
      throw placed(`${spelled} ${error.message}`, position);
    }
  }
}

import { Address, InstanceKey } from '@clay/contracts';
import { ParsedReference, Position, spellReference, Step } from '@clay/parser';

import { Instances, repetitionOfKey } from '../Instances';
import { blockKey, Context, dataSourceKey, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { checkHasKey, checkInRange, instanceKeyIn } from './instance';

function check(spelled: string, key: InstanceKey, keys: InstanceKey[] | undefined, position?: Position): void {
  if (typeof key === 'number') checkInRange(spelled, key, keys?.length, position);
  else checkHasKey(spelled, key, keys, position);
}

/** Refuses a key the block's count or for_each does not make, since an instance not made yet would read as unknown, not missing. */
export class InstanceKeys {
  constructor(
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  /** Where the key is read, so one in a result a condition does not pick, or in the body of a for over nothing, is not refused. */
  of(reference: ParsedReference, context: Context, position?: Position): void {
    if (reference.kind === 'resource') this.resource(reference.type, reference.name, reference.path, context, position);
    if (reference.kind === 'data') this.data(reference.type, reference.name, reference.path, context, position);
    if (reference.kind === 'module') this.call(reference.module, reference.path, context, position);
  }

  private resource(type: string, name: string, path: Step[], context: Context, position?: Position): void {
    const block = new Address(moduleOf(context), type, name);
    const key = instanceKeyIn(path);
    if (key === undefined || this.instances.repetitionOf(blockKey(block)) !== repetitionOfKey(key)) return;

    check(spellReference([{ name: type }, { name }]), key, this.instances.keysOf(block.toString()), position);
  }

  private data(type: string, name: string, path: Step[], context: Context, position?: Position): void {
    const module = moduleOf(context);
    const key = instanceKeyIn(path);
    if (key === undefined || this.instances.repetitionOf(dataSourceKey(scopeOf(module.withoutKeys()), type, name)) !== repetitionOfKey(key)) return;

    check(`data.${type}.${name}`, key, this.instances.keysOf(dataSourceKey(scopeOf(module), type, name)), position);
  }

  private call(module: string, path: Step[], context: Context, position?: Position): void {
    const call = moduleOf(context).child(module);
    const key = instanceKeyIn(path);
    if (key === undefined || this.modules.repetitionOf(call.withoutKeys()) !== repetitionOfKey(key)) return;

    check(spellReference([{ name: 'module' }, { name: module }]), key, this.modules.keysOf(call), position);
  }
}

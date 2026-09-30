import { ModuleOutputReference, Position, Step } from '@clay/parser';

import { Context, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { ScopeManager } from '../scope/ScopeManager';
import { readCall } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver {
  constructor(
    private scopeManager: ScopeManager,
    private modules: ModuleInstances
  ) {}

  /** The output the reference reads, of the instance its index names, and the steps still to take into it. */
  resolve(reference: ModuleOutputReference, context: Context, position?: Position): { value: unknown; path: Step[] } {
    const caller = moduleOf(context);
    const { key, output, path } = readCall(reference, this.modules.repetitionOf(caller.child(reference.module).withoutKeys()), position);
    const scope = scopeOf(caller.child(reference.module, key));

    const value = this.scopeManager.getOutput(scope, output);
    if (value === undefined) throw new UnresolvedReferenceError(`module "${reference.module}" has no output "${output}"`);

    return { value, path };
  }
}

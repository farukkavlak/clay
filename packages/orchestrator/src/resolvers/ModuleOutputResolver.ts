import { ModuleOutputReference } from '@clay/parser';
import { Context, moduleOf, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver {
  constructor(private scopeManager: ScopeManager) {}

  resolve(reference: ModuleOutputReference, context: Context): unknown {
    const scope = scopeOf(moduleOf(context).child(reference.module));

    const output = this.scopeManager.getOutput(scope, reference.output);
    if (output === undefined) throw new UnresolvedReferenceError(`Output "${reference.output}" not found in module "${scope}"`);

    return output;
  }
}

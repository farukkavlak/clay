import { Address } from '@clay/contracts';
import { ModuleOutputReference } from '@clay/parser';
import { childScope, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver {
  constructor(private scopeManager: ScopeManager) {}

  resolve(reference: ModuleOutputReference, context: Address): unknown {
    const scope = childScope(scopeOf(context), reference.module);

    const output = this.scopeManager.getOutput(scope, reference.output);
    if (output === undefined) throw new UnresolvedReferenceError(`Output "${reference.output}" not found in module "${scope}"`);

    return output;
  }
}

import { IState } from '@clay/state';

import { Address } from '../Address';
import { ScopeManager } from '../scope/ScopeManager';
import { IResolver } from './IResolver';

export class VariableResolver implements IResolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: { resolveValue: (value: unknown, state: IState, context?: Address) => unknown }
  ) {}

  resolve(pathParts: string[], context: Address, state: IState): unknown {
    const varName = pathParts[1];
    const scope = this.scopeManager.getScope(context);

    const scopeVars = this.scopeManager.getVariable(scope, varName);
    if (!scopeVars) throw new Error(`variable "${varName}" is not defined`);

    return this.referenceResolver.resolveValue(scopeVars.value, state, scopeVars.context);
  }
}

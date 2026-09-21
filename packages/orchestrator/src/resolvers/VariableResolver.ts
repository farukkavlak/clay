import { Address, State } from '@clay/contracts';
import { scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { Resolver } from './Resolver';

export class VariableResolver implements Resolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: { resolveValue: (value: unknown, state: State, context?: Address) => unknown }
  ) {}

  resolve(pathParts: string[], context: Address, state: State): unknown {
    const varName = pathParts[1];
    const scope = scopeOf(context);

    const scopeVars = this.scopeManager.getVariable(scope, varName);
    if (!scopeVars) throw new Error(`variable "${varName}" is not defined`);

    return this.referenceResolver.resolveValue(scopeVars.value, state, scopeVars.context);
  }
}

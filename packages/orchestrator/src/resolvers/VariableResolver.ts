import { State } from '@clay/contracts';
import { VariableReference } from '@clay/parser';
import { Context, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';

export class VariableResolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: { resolveValue: (value: unknown, state: State, context?: Context) => unknown }
  ) {}

  resolve(reference: VariableReference, context: Context, state: State): unknown {
    const scope = scopeOf(context);

    const scopeVars = this.scopeManager.getVariable(scope, reference.name);
    if (!scopeVars) throw new Error(`variable "${reference.name}" is not defined`);

    return this.referenceResolver.resolveValue(scopeVars.value, state, scopeVars.context);
  }
}

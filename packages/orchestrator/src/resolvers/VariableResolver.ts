import { State } from '@clay/contracts';
import { VariableReference } from '@clay/parser';
import { Context, enclosing, moduleOf, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';

export class VariableResolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: { resolveValue: (value: unknown, state: State, context?: Context) => unknown }
  ) {}

  resolve(reference: VariableReference, context: Context, state: State): unknown {
    const module = moduleOf(context);

    const declared = this.scopeManager.getVariable(scopeOf(module.withoutKeys()), reference.name);
    if (!declared) throw new Error(`variable "${reference.name}" is not defined`);

    // An input is read in the instance of the calling module that this instance sits in.
    return this.referenceResolver.resolveValue(declared.value, state, enclosing(module, declared.context));
  }
}

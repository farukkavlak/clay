import { State } from '@clay/contracts';
import { AttributeValue, VariableReference } from '@clay/parser';
import { Context, contextIn, moduleOf, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { Value } from '../Value';
import { typeInto } from './readPath';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class VariableResolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: { resolveValue: (value: AttributeValue, state: State, context?: Context) => Value }
  ) {}

  resolve(reference: VariableReference, context: Context, state: State): Value {
    const module = moduleOf(context);

    const declared = this.scopeManager.getVariable(scopeOf(module.withoutKeys()), reference.name);
    if (!declared) throw new Error(`variable "${reference.name}" is not defined`);

    try {
      return this.referenceResolver.resolveValue(declared.value, state, contextIn(declared.context, module));
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      // The type it has is the variable's; what reads into the variable reads the type its steps find.
      throw new UnresolvedReferenceError(error.message, typeInto(error.type, reference.path));
    }
  }
}

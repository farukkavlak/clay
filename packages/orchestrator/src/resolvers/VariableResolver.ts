import { State, UNKNOWN } from '@clay/contracts';
import { AttributeValue, VariableReference } from '@clay/parser';
import { SchemaMismatch } from '../conformValues';
import { givenTo } from '../declared';
import { Context, contextIn, moduleOf, scopeOf } from '../keys';
import { withPlace } from '../place';
import { ScopeManager, VariableValue } from '../scope/ScopeManager';
import { Value, valueOf } from '../Value';
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

    const where = contextIn(declared.context, module);
    try {
      return this.typed(reference.name, declared, this.referenceResolver.resolveValue(declared.value, state, where), where, state);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      // The type it has is the variable's; what reads into the variable reads the type its steps find.
      const type = this.typed(reference.name, declared, valueOf(error.type, UNKNOWN), where, state).type;
      throw new UnresolvedReferenceError(error.message, typeInto(type, reference.path));
    }
  }

  /** A value of the wrong type is the mistake of where it is written, not of where it is read, so it is refused there. */
  private typed(name: string, declared: VariableValue, resolved: Value, where: Context, state: State): Value {
    try {
      return givenTo(name, resolved, declared, (node) => this.referenceResolver.resolveValue(node, state, where));
    } catch (error) {
      if (error instanceof SchemaMismatch) throw withPlace(error, declared.value.position, declared.block, where);
      throw error;
    }
  }
}

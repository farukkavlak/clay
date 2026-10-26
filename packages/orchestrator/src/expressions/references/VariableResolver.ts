import { ModuleAddress, State } from '@clay/contracts';
import { AttributeValue, VariableReference } from '@clay/parser';
import { SchemaMismatch } from '../../values/conformValues';
import { givenTo } from '../../values/declared';
import { Context, contextIn, moduleOf, scopeOf } from '../../keys';
import { withPlace } from '../../place';
import { ScopeManager, VariableValue } from '../../config/ScopeManager';
import { RuleReader, validate, ValidationFailed } from '../validations';
import { Value } from '../../values/Value';
import { unknownOf, UnresolvedReferenceError } from '../UnresolvedReferenceError';

export class VariableResolver {
  constructor(
    private scopeManager: ScopeManager,
    private referenceResolver: RuleReader & { resolveValue: (value: AttributeValue, state: State, context?: Context) => Value }
  ) {}

  resolve(reference: VariableReference, context: Context, state: State): Value {
    const module = moduleOf(context);

    const declared = this.scopeManager.getVariable(scopeOf(module.withoutKeys()), reference.name);
    if (!declared) throw new Error(`variable "${reference.name}" is not defined`);

    const where = contextIn(declared.context, module);
    try {
      return this.typed(reference.name, declared, this.referenceResolver.resolveValue(declared.value, state, where), { where, module }, state);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      // The unknown takes the variable's type, and the reader checks the reference's steps against it.
      return this.typed(reference.name, declared, unknownOf(error), { where, module }, state);
    }
  }

  /**
   * A wrong type, or a value a rule refuses, is reported where the value is written, not where it is read.
   * `where` is where the value is written, and `module` the instance that declares the variable.
   */
  private typed(name: string, declared: VariableValue, resolved: Value, { where, module }: { where: Context; module: ModuleAddress }, state: State): Value {
    try {
      const value = givenTo('variable', name, resolved, declared, (node) => this.referenceResolver.resolveValue(node, state, where));
      validate(name, declared, value, { module, state, reader: this.referenceResolver });
      return value;
    } catch (error) {
      if (error instanceof SchemaMismatch || error instanceof ValidationFailed) throw withPlace(error, declared.value.position, declared.block, where);
      throw error;
    }
  }
}

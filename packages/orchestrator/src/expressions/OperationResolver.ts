import { AttributePath, isUnknown, State, Type, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, BinaryNode, ConditionalNode, ConfigError, NegateNode, NotNode } from '@clay/parser';

import { converted } from '../values/conformValues';
import { Context } from '../keys';
import { Arithmetic, arithmetic, asNumber, checkBoolean, equality, isOrdering, negated, negative, NumberValue, Ordering, ordering } from './operators';
import { unified, unifiedLater, Unjoinable, unjoined } from '../values/unify';
import { allSensitiveIf, mayBeSensitive, Value, valueOf, withSensitive } from '../values/Value';
import { isSensitive, marksOfWhole, sharedMarks, wholeOf } from '../values/sensitive';
import { Evaluator, Reading } from './Evaluator';

export type Operation = BinaryNode | NotNode | NegateNode | ConditionalNode;

export function isOperation(node: AttributeValue): node is Operation {
  return node.type === 'Binary' || node.type === 'Not' || node.type === 'Negate' || node.type === 'Conditional';
}

/** Neither side decides `&&` or `||` yet. One not known may still decide alone, so a mark on the other is the answer's only where both have it, and may be where either has one. */
function undecidedMarks(left: Value, right: Value): AttributePath[] {
  const [leftMarked, rightMarked] = [isSensitive(left), isSensitive(right)];
  const sensitive = (leftMarked && !isUnknown(right.data)) || (rightMarked && !isUnknown(left.data)) || (leftMarked && rightMarked);

  return marksOfWhole({ sensitive, maybe: mayBeSensitive(left) || mayBeSensitive(right) }, []);
}

/** Either side may decide, so the answer is sensitive where both are, and may be where either may. */
function eitherDecides(answer: boolean, left: Value, right: Value): Value {
  const whole = { sensitive: isSensitive(left) && isSensitive(right), maybe: mayBeSensitive(left) || mayBeSensitive(right) };

  return withSensitive(valueOf(types.bool, answer), marksOfWhole(whole, []));
}

/** The results in the order written: when true, then when false. With `later`, the one picked is still to come, so one of no type may turn out to be of any type. */
function resultType(node: ConditionalNode, [whenTrue, whenFalse]: Value[], later = false): Type {
  try {
    return later ? unifiedLater([whenTrue, whenFalse]) : unified([whenTrue.type, whenFalse.type]);
  } catch (error) {
    if (!(error instanceof Unjoinable)) throw error;
    throw new ConfigError(`The two results of a conditional ${unjoined(error, mayBeSensitive(whenTrue) || mayBeSensitive(whenFalse))}`, node.whenTrue.position);
  }
}

/** The picked value takes the type both results join into, which a value of no type until read may still not fit; one still to come keeps its own. */
function fitted(taken: AttributeValue, value: Value, written: Type): Value {
  try {
    return converted('A conditional', value, unifiedLater([value], [], [written]), []);
  } catch (error) {
    if (!(error instanceof Unjoinable)) throw error;
    throw new ConfigError(`The result a condition picks ${unjoined(error, mayBeSensitive(value))}`, taken.position);
  }
}

/** Reads an operator, `!`, a negation and a conditional. */
export class OperationResolver {
  constructor(private readonly evaluate: Evaluator) {}

  resolveOperation(node: Operation, state: State, context: Context | undefined, reading: Reading): Value {
    if (node.type === 'Not') return negated(this.evaluate.boolean(node.value, '!', state, context, reading));
    if (node.type === 'Negate') return negative(this.number(node.value, '-', state, context, reading));
    if (node.type === 'Conditional') return this.resolveConditional(node, state, context, reading);
    if (node.operator === '&&' || node.operator === '||') return this.resolveLogic(node, node.operator, state, context, reading);
    if (node.operator === '==' || node.operator === '!=')
      return equality(
        node.operator,
        this.evaluate.resolveItem(node.left, state, context, reading),
        this.evaluate.resolveItem(node.right, state, context, reading),
        node.operatorPosition
      );

    return this.resolveNumbers(node, node.operator, state, context, reading);
  }

  private resolveNumbers(node: BinaryNode, operator: Arithmetic | Ordering, state: State, context: Context | undefined, reading: Reading): Value {
    const left = this.number(node.left, operator, state, context, reading);
    const right = this.number(node.right, operator, state, context, reading);

    return isOrdering(operator) ? ordering(operator, left, right, node.operatorPosition) : arithmetic(operator, left, right, node.operatorPosition);
  }

  private number(node: AttributeValue, who: string, state: State, context: Context | undefined, reading: Reading): NumberValue {
    return asNumber(who, this.evaluate.resolveItem(node, state, context, reading), node.position);
  }

  /** A known left side that decides the answer leaves the right read by type only, so `var.x != null && var.x.on` reads `.on` only when there is an x. */
  private resolveLogic(node: BinaryNode, operator: '&&' | '||', state: State, context: Context | undefined, reading: Reading): Value {
    const deciding = operator === '||';
    const decided = (by: Value) => withSensitive(valueOf(types.bool, deciding), wholeOf(by));

    const left = this.evaluate.boolean(node.left, operator, state, context, reading);
    if (left.data === deciding) {
      checkBoolean(operator, this.evaluate.byType(node.right, context, reading), node.right.position);
      return decided(left);
    }

    const right = this.evaluate.boolean(node.right, operator, state, context, reading);
    const later = isUnknown(left.data);
    // With the left side not known yet, either side may decide: sensitive where both are, and so it may be where either may.
    if (right.data === deciding) return later ? eitherDecides(deciding, left, right) : decided(right);

    const data = later || isUnknown(right.data) ? UNKNOWN : !deciding;
    return withSensitive(valueOf(types.bool, data), undecidedMarks(left, right));
  }

  /**
   * A known condition leaves the other result read by type only, so `var.x == null ? "none" : var.x.name` reads `.name` only when there is an x.
   * The type is what both results join into as written, so the condition changes it only where a value has no type until it is read.
   */
  private resolveConditional(node: ConditionalNode, state: State, context: Context | undefined, reading: Reading): Value {
    const condition = this.evaluate.boolean(node.condition, 'A condition', state, context, reading);
    if (isUnknown(condition.data)) {
      const results = [node.whenTrue, node.whenFalse].map((result) => this.evaluate.resolveItem(result, state, context, reading));
      // Only one result is the value, so it has the condition's mark and the marks both results have.
      return withSensitive(
        valueOf(resultType(node, results, true), UNKNOWN),
        marksOfWhole({ sensitive: isSensitive(condition), maybe: mayBeSensitive(condition) }, sharedMarks(results))
      );
    }

    const written = resultType(node, [this.evaluate.byType(node.whenTrue, context, reading), this.evaluate.byType(node.whenFalse, context, reading)]);
    const taken = condition.data === true ? node.whenTrue : node.whenFalse;
    const picked = fitted(taken, this.evaluate.resolveItem(taken, state, context, reading), written);

    return allSensitiveIf(isSensitive(condition), picked);
  }
}

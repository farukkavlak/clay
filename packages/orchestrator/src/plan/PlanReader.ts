import { State } from '@clay/contracts';
import { AttributeValue, DataBlock, ResourceBlock, spell, Statement } from '@clay/parser';

import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { unknownOf, UnresolvedReferenceError } from '../expressions/UnresolvedReferenceError';
import { countFrom } from '../instances/count';
import { eachFrom } from '../instances/forEach';
import { Instances } from '../instances/Instances';
import { NotKnownYet } from '../instances/NotKnownYet';
import { Context } from '../keys';
import { tryAt } from '../place';
import { Value } from '../values/Value';

/** A plan reads the data sources it can and refuses a count or for_each only an apply knows; a check reads none and accepts one. */
export type Walk = 'plan' | 'check';

/** Undefined where only an apply knows it. */
function orLater<T>(parse: (value: Value) => T): (value: Value) => T | undefined {
  return (value): T | undefined => {
    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof NotKnownYet)) throw error;
      return undefined;
    }
  };
}

/** Reads values for a plan, where a value only the apply knows reads as unknown. */
export class PlanReader {
  constructor(
    private resolver: ReferenceResolver,
    private instances: Instances
  ) {}

  resolveOrUnknown(value: AttributeValue, state: State, context: Context): Value {
    try {
      return this.resolver.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return unknownOf(error);
    }
  }

  /** For count and for_each, read before any instance exists. Undefined where only an apply knows it and a check reads it. */
  readAt<T>(walk: Walk, value: AttributeValue, block: Statement, context: Context, state: State, read: (value: Value) => T): T | undefined {
    const parse = walk === 'check' ? orLater(read) : read;

    return tryAt(value.position, spell(block), context, () => parse(this.resolveOrUnknown(value, state, context)));
  }

  /** Left unset where only an apply knows them: the block makes no instance, and what reads it is not known yet. */
  setKeys(walk: Walk, key: string, block: ResourceBlock | DataBlock, context: Context, state: State): void {
    const count = block.count && this.readAt(walk, block.count, block, context, state, countFrom);
    const each = block.forEach && this.readAt(walk, block.forEach, block, context, state, eachFrom);

    if (count !== undefined) this.instances.setCount(key, count);
    if (each !== undefined) this.instances.setEach(key, each);
  }
}

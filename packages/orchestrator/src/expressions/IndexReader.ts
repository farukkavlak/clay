import { AttributePath, EVERY_ITEM, isUnknown, sensitiveUnder, State, types } from '@clay/contracts';
import { AttributeValue, BoundNode, ConfigError, IndexNode, Position, ReferenceNode, spellIndex, Step, stepKey } from '@clay/parser';

import { Context } from '../keys';
import { isSensitive, itemsOf, marksOfWhole, sharedMarks, Whole, wholeWhere } from '../values/sensitive';
import { mayBeSensitive, Value, wholeIf } from '../values/Value';
import { Evaluator, Reading } from './Evaluator';
import { checkUnknownIndex, keyOf } from './indexKey';
import { unknownOf, UnresolvedReferenceError } from './UnresolvedReferenceError';

type Named = ReferenceNode | IndexNode | BoundNode;

/** The node being read, and what its indexes are read with. */
interface Site {
  node: Named;
  state: State;
  context: Context | undefined;
  reading: Reading;
}

export type Reader = (steps: Step[]) => Value;

/** `later` is the first index whose value is not known yet, and `steps` stop before it. */
interface Keyed {
  steps: Step[];
  /** Whether an index is sensitive, and whether one may be. */
  whole: Whole;
  later?: Step;
  /** The key of each step after `later`; every item where another index is not known yet. */
  rest: (string | number)[];
}

/** Only that the read failed is told, since why may say what the sensitive value is. */
function hidingIf(sensitive: boolean, message: string, position: Position, read: () => Value): Value {
  if (!sensitive) return read();

  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(message, position);
    if (error instanceof UnresolvedReferenceError) throw new UnresolvedReferenceError(message, error.type, wholeIf(true));
    throw error;
  }
}

/** What went wrong reading at a sensitive index may quote the index. */
function atSensitiveIndex(node: Named): string {
  return `${spellIndex(node)} was read at a sensitive index, so why it failed is not shown`;
}

/** The marks under `keys`. */
function marksAlong(paths: AttributePath[], keys: (string | number)[]): AttributePath[] {
  return keys.reduce((marks, key) => sensitiveUnder(marks, key), paths);
}

/** Reads the steps after a name, where an index is itself a value to work out. */
export class IndexReader {
  constructor(private readonly evaluate: Evaluator) {}

  /**
   * An index read from a value takes the key it comes to, and what it finds is sensitive when the index is.
   * An index not known yet makes the result unknown, with the marks every item has along the steps after it, or whole where an index is sensitive.
   */
  readWith(site: Site, steps: Step[], read: Reader): Value {
    if (!steps.some((step) => 'index' in step)) return read(steps);

    const keyed = this.keyed(steps, site);
    if (keyed.later) return this.readLater(site.node, keyed, read);

    const { sensitive, maybe } = keyed.whole;
    return wholeWhere(
      hidingIf(sensitive, atSensitiveIndex(site.node), site.node.position, () => read(keyed.steps)),
      sensitive,
      maybe
    );
  }

  indexOf(node: AttributeValue, { state, context, reading }: Site): Value {
    try {
      return this.evaluate.resolveIn(node, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return unknownOf(error);
    }
  }

  /** The steps before the first index not known yet, with a key for each index read from a value, and the keys after it. */
  private keyed(steps: Step[], site: Site): Keyed {
    const keyed: Keyed = { steps: [], whole: { sensitive: false, maybe: false }, rest: [] };

    for (const step of steps) {
      const { key, index } = this.keyOfStep(step, site);
      if (index) keyed.whole = { sensitive: keyed.whole.sensitive || isSensitive(index), maybe: keyed.whole.maybe || mayBeSensitive(index) };
      if (keyed.later) keyed.rest.push(key === undefined ? EVERY_ITEM : stepKey(key));
      else if (key === undefined) keyed.later = step;
      else keyed.steps.push(key);
    }

    return keyed;
  }

  /** A step as it reads, with the key an index comes to and the index read; no key for an index not known yet. */
  private keyOfStep(step: Step, site: Site): { key?: Step; index?: Value } {
    if (!('index' in step)) return { key: step };

    const index = this.indexOf(step.index, site);
    if (!isUnknown(index.data)) return { key: keyOf(index, step), index };

    checkUnknownIndex(index, step);
    return { index };
  }

  /** The type the rest would find is not known without the index, so the unknown has none. Whichever item it reads, it has what every item has. */
  private readLater(node: Named, { steps, whole, rest }: Keyed, read: Reader): never {
    let items: Value[];

    try {
      items = itemsOf(hidingIf(whole.sensitive, atSensitiveIndex(node), node.position, () => read(steps)));
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      items = itemsOf(unknownOf(error));
    }

    throw new UnresolvedReferenceError(`${spellIndex(node)} is known only after apply`, types.dynamic, marksOfWhole(whole, marksAlong(sharedMarks(items), rest)));
  }
}

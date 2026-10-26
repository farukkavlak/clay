import { AttributePath, EVERY_ITEM, isUnknown, sensitiveUnder, SOMEWHERE, State, Type, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, ForNode } from '@clay/parser';

import {
  certainItem,
  certainSteps,
  checkCollection,
  checkKey,
  forItems,
  goer,
  ForItem,
  forObject,
  laterObjectMarks,
  laterTupleMarks,
  maybeSteps,
  namesAStep,
  namesEveryItem,
  pickedTupleMarks,
  refuseDuplicateKeys,
  under,
  unknownItem,
} from './forItems';
import { Context } from '../keys';
import { Planned } from '../values/Planned';
import { isAllSensitive, mayBeSensitive, sensitiveSomewhere, tupleOf, unordered, Value, valueOf, wholeIf, withSensitive } from '../values/Value';
import { anyItemMarks, fewest, isSensitive, marksOfWhole, maybeMarks, mayBeAllSensitive, Whole, wholeWhere } from '../values/sensitive';
import { unknownOf, UnresolvedReferenceError } from './UnresolvedReferenceError';
import { Evaluator, Reading } from './Evaluator';

function withNames(reading: Reading, node: ForNode, [key, value]: ForItem): Reading {
  const names = new Map(reading.given).set(node.valueName, value);

  return { ...reading, given: node.keyName === undefined ? names : names.set(node.keyName, key) };
}

const FOR_IF = 'The if of a for';

/** The items an if may keep; `later` where its value for one is not known yet. */
interface Picked {
  items: Reading[];
  /** For each item, whether the if keeps it whatever the apply finds. */
  kept: boolean[];
  /** Whether an if is sensitive, and whether one may be. */
  whole: Whole;
  later: boolean;
}

interface ReadItem {
  key?: Value;
  body: Value;
  condition?: Value;
}

/** Read with an item that stands for every one, and again with each item the collection holds for certain. */
interface ReadOnce extends Partial<ReadItem> {
  certain: (ReadItem & { step: string | number })[];
  /** How many of `certain` come first, in the order the for goes over them. */
  leading: number;
  /** An item the collection holds for certain, though not which: any member of a set with one not known yet, or the one where a collection sensitive somewhere is. */
  held?: ReadItem;
  /** Each item at a key or place only a mark that it may be sensitive names, which the collection may not hold. */
  maybe: (ReadItem & { step: string | number })[];
  /** An item at a key or place no mark names. */
  other?: ReadItem;
}

const keptForCertain = (item: ReadItem) => item.condition === undefined || item.condition.data === true;

/**
 * Each item has what the body has for every item; one the collection holds for certain keeps its marks at its key, or, with no if, at its place.
 * The first `leading` of `certain` come first in the order the for goes over them, so one kept for certain before any that may be dropped
 * keeps its place, in a group too. Any other item comes after them: `other`, at a key or place no mark names, which a collection whose type
 * names every item has none of, then each the collection may hold, at its own key or, with no if, its own place.
 */
function laterForMarks(node: ForNode, collection: Type, { other, certain, leading, maybe }: ReadOnce): AttributePath[] {
  const unnamed: (ReadItem & { step?: string | number })[] = namesEveryItem(collection) || other === undefined ? [] : [other];
  const items = [...certain.slice(0, leading), ...unnamed, ...certain.slice(leading), ...maybe];
  const sure = new Set<ReadItem>(certain);
  const kept = items.map((item) => sure.has(item) && keptForCertain(item));
  if (node.key)
    return laterObjectMarks(
      items.map((item): ForItem => [item.key ?? valueOf(types.dynamic, UNKNOWN), item.body]),
      kept,
      node.grouped === true,
      leading
    );
  if (node.condition)
    return pickedTupleMarks(
      items.map((item) => item.body),
      kept,
      leading
    );

  const placed = items.map((item) => typeof item.step === 'number');
  const places = items.flatMap(({ step, body }, index) => (placed[index] && step !== undefined ? under(step, kept[index] ? (body.sensitive ?? []) : maybeMarks([body])) : []));
  return fewest([
    ...laterTupleMarks(
      items.map((item) => item.body),
      kept,
      placed
    ),
    ...places,
  ]);
}

/** An item held for certain decides the size where its if is sensitive, and the keys where it is kept and its key is sensitive. */
function heldDecides(held: ReadItem | undefined): boolean {
  if (held === undefined) return false;

  return (held.condition !== undefined && isSensitive(held.condition)) || (keptForCertain(held) && held.key !== undefined && isSensitive(held.key));
}

/** An item held for certain, not known which, makes the for sensitive somewhere where it is kept and its body is sensitive for certain. */
const heldSensitive = (held: ReadItem | undefined) => held !== undefined && keptForCertain(held) && isSensitive(held.body);

/** Reads a for expression, before what it goes over is known too, with the marks each item gives what it makes. */
export class ForResolver {
  constructor(
    private readonly evaluate: Evaluator,
    private readonly planned: Planned
  ) {}

  /** Over a collection sensitive as a whole, or with a sensitive if, what it gives is too: how many items it keeps tells the if. */
  resolveFor(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    const collection = this.collectionOf(node, state, context, reading);
    const names = forItems(collection, node).map((item) => withNames(reading, node, item));
    const picked = this.picked(node, names, state, context);
    const whole = { sensitive: isAllSensitive(collection) || picked.whole.sensitive, maybe: picked.whole.maybe };
    if (picked.later) throw this.laterPicked(node, picked, whole, state, context);

    const made = node.key
      ? this.resolveForObject(node, node.key, picked.items, whole, state, context)
      : tupleOf(picked.items.map((itemNames) => this.evaluate.resolveItem(node.body, state, context, itemNames)));

    return wholeWhere(made, whole.sensitive, whole.maybe);
  }

  /** The items the if may keep. One it leaves out is read by type only, so `x.name if x != null` reads `.name` only where there is an x. */
  private picked(node: ForNode, names: Reading[], state: State, context: Context | undefined): Picked {
    const { condition } = node;
    if (!condition) return { items: names, kept: names.map(() => true), whole: { sensitive: false, maybe: false }, later: false };

    const ifs = names.map((itemNames) => this.evaluate.boolean(condition, FOR_IF, state, context, itemNames));
    for (const [index, itemNames] of names.entries()) if (ifs[index].data === false) this.readItemByType(node, itemNames, context);

    const maybe = ifs.filter((value) => value.data !== false);
    return {
      items: names.filter((_, index) => ifs[index].data !== false),
      kept: maybe.map((value) => value.data === true),
      whole: { sensitive: ifs.some((value) => isSensitive(value)), maybe: ifs.some((value) => mayBeSensitive(value)) },
      later: ifs.some((value) => isUnknown(value.data)),
    };
  }

  private readItemByType(node: ForNode, itemNames: Reading, context: Context | undefined): void {
    if (node.key) checkKey(this.evaluate.byType(node.key, context, itemNames), node.key.position);
    this.evaluate.byType(node.body, context, itemNames);
  }

  /**
   * Which items an if keeps waits for the apply, but two it keeps for certain are there whatever the apply finds, so a key both give is refused now.
   * Every item it may keep is read now, so a mistake in any is found.
   * Only marks every outcome has are kept: a sensitive key of an item kept for certain makes it sensitive as a whole.
   */
  private laterPicked(node: ForNode, { items, kept }: Picked, whole: Whole, state: State, context: Context | undefined): UnresolvedReferenceError {
    const { key } = node;
    const keys = key ? items.map((itemNames) => this.checkedKey(key, state, context, itemNames)) : [];
    const bodies = items.map((itemNames) => this.evaluate.resolveItem(node.body, state, context, itemNames));
    if (key && !node.grouped)
      refuseDuplicateKeys(
        keys.filter((_, index) => kept[index]),
        key.position
      );

    const message = 'The if of a for is known only after apply for an item, so what the for gives is not known yet';
    const keyed = {
      sensitive: whole.sensitive || keys.some((found, index) => kept[index] && isSensitive(found)),
      maybe: whole.maybe || keys.some((found) => mayBeSensitive(found)),
    };
    if (keyed.sensitive) return new UnresolvedReferenceError(message, types.dynamic, wholeIf(true));

    const marks = key
      ? laterObjectMarks(
          keys.map((found, index): ForItem => [found, bodies[index]]),
          kept,
          node.grouped === true
        )
      : pickedTupleMarks(bodies, kept);
    return new UnresolvedReferenceError(message, types.dynamic, marksOfWhole(keyed, marks));
  }

  private checkedKey(key: AttributeValue, state: State, context: Context | undefined, itemNames: Reading): Value {
    const found = this.evaluate.resolveItem(key, state, context, itemNames);
    checkKey(found, key.position);
    return found;
  }

  /** Resolves every key and value first, so an error in any item is found even when another key is unknown. */
  private resolveForObject(node: ForNode, key: AttributeValue, items: Reading[], whole: Whole, state: State, context: Context | undefined): Value {
    const entries = items.map((itemNames): ForItem => [this.evaluate.resolveItem(key, state, context, itemNames), this.evaluate.resolveItem(node.body, state, context, itemNames)]);

    return forObject(entries, node.grouped === true, whole, key.position);
  }

  /**
   * An unknown collection, or a set with an unknown member, has no known items or order, so the for waits for apply.
   * Its type is still checked now.
   */
  private collectionOf(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    let collection: Value;
    try {
      collection = this.evaluate.resolveIn(node.collection, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      const later = unknownOf(error);
      checkCollection(later, node);
      throw this.laterFor(node, later, error.message, state, context, reading);
    }

    // A condition or an operator gives a value not known yet where a reference would throw.
    if (isUnknown(collection.data)) {
      checkCollection(collection, node);
      throw this.laterFor(node, collection, `What ${goer(node)} goes over is known only after apply`, state, context, reading);
    }
    if (unordered(collection))
      throw this.laterFor(node, collection, `The set ${goer(node)} goes over has a member known only after apply, so it has no order yet`, state, context, reading);
    return collection;
  }

  /**
   * Its size and keys are the collection's, the key's and the if's, so it is sensitive as a whole where any is, or where an item it keeps for certain
   * has a sensitive key. It has no type: a for makes a tuple or an object whatever it iterates.
   */
  private laterFor(node: ForNode, collection: Value, message: string, state: State, context: Context | undefined, reading: Reading): UnresolvedReferenceError {
    const read = this.readOnce(node, collection, state, context, reading);
    const { key, body, condition, certain, held } = read;
    const kept = certain.filter((item) => keptForCertain(item));
    if (node.key && !node.grouped)
      refuseDuplicateKeys(
        kept.flatMap((item) => (item.key === undefined ? [] : [item.key])),
        node.key.position
      );
    const decided = [...certain, held].some((item) => heldDecides(item));
    const whole = {
      sensitive: [key, condition].some((part) => part !== undefined && isSensitive(part)) || isAllSensitive(collection) || decided,
      maybe: [key, condition].some((part) => part !== undefined && mayBeSensitive(part)) || mayBeAllSensitive(collection),
    };
    if (whole.sensitive) return new UnresolvedReferenceError(message, types.dynamic, wholeIf(true));

    // Read without a body outside the plan, where no mark is shown, so each item is marked where any of the collection is for certain.
    if (body === undefined) return new UnresolvedReferenceError(message, types.dynamic, isSensitive(collection) ? [[EVERY_ITEM]] : []);

    const marks = laterForMarks(node, collection.type, read);
    return new UnresolvedReferenceError(message, types.dynamic, marksOfWhole(whole, heldSensitive(held) ? fewest([...marks, [SOMEWHERE]]) : marks));
  }

  /**
   * The key, the body and the if with an unknown item, so an error or a sensitive value in them is found before the collection is known,
   * with each item the collection holds for certain or may hold, with one at a key or place no mark names, and with the one it holds though not which.
   */
  private readOnce(node: ForNode, collection: Value, state: State, context: Context | undefined, reading: Reading): ReadOnce {
    if (!(reading.asWritten || this.planned.isPlanning())) return { certain: [], leading: 0, maybe: [] };

    const [itemKey, itemValue] = unknownItem(collection.type);
    const every = anyItemMarks(collection.sensitive ?? []);
    const once = this.readItem(node, [itemKey, withSensitive(itemValue, every)], state, context, reading);
    const { steps, leading } = certainSteps(collection);
    const read = (step: string | number) => ({ step, ...this.readItem(node, certainItem(collection, step), state, context, reading) });
    const maybe = maybeSteps(collection, steps);
    const others = sensitiveUnder(collection.sensitive ?? [], EVERY_ITEM);
    const other = namesAStep(collection) ? this.readItem(node, [itemKey, withSensitive(itemValue, others)], state, context, reading) : once;

    return {
      ...once,
      certain: steps.map((step) => read(step)),
      leading,
      maybe: maybe.map((step) => read(step)),
      other,
      held: this.heldItem(node, collection, once, state, context, reading),
    };
  }

  /** Read again with an item sensitive somewhere where the collection is; a set with a member not known yet holds one like any other. */
  private heldItem(node: ForNode, collection: Value, once: ReadItem, state: State, context: Context | undefined, reading: Reading): ReadItem | undefined {
    if (sensitiveSomewhere(collection)) {
      const [itemKey, itemValue] = unknownItem(collection.type);
      const marks = [...sensitiveUnder(collection.sensitive ?? [], EVERY_ITEM), [SOMEWHERE]];
      return this.readItem(node, [itemKey, withSensitive(itemValue, marks)], state, context, reading);
    }

    return Array.isArray(collection.data) && collection.data.length > 0 ? once : undefined;
  }

  private readItem(node: ForNode, item: ForItem, state: State, context: Context | undefined, reading: Reading): ReadItem {
    const names = withNames(reading, node, item);
    const key = node.key && this.evaluate.resolveItem(node.key, state, context, names);
    const body = this.evaluate.resolveItem(node.body, state, context, names);
    if (key && node.key) checkKey(key, node.key.position);
    const condition = node.condition && this.evaluate.boolean(node.condition, FOR_IF, state, context, names);

    return { key, body, condition };
  }
}

import { State } from '@clay/contracts';
import { AttributeValue } from '@clay/parser';

import { Context } from '../keys';
import { Value } from '../values/Value';

/** Values bound by enclosing for expressions. */
export type Given = ReadonlyMap<string, Value>;

/**
 * With `asWritten`, a reference reads as unknown of the type it will have, and a local as its value read the same way.
 * With `byType` too, a local and a call's result read as unknown as well, so nothing is read for its value.
 */
export interface Reading {
  given: Given;
  asWritten: boolean;
  byType?: true;
  /** A variable's value, already worked out, so its own rules read it without reading it again. */
  variable?: { name: string; value: Value };
}

export const READING: Reading = { given: new Map(), asWritten: false };

/** What each kind of expression reads its own parts with, so each kind can be read by a class of its own. */
export interface Evaluator {
  /** Throws where a value waits for the apply. */
  resolveIn(node: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value;
  /** At plan time a part only the apply knows becomes UNKNOWN by itself, so the rest stays known. */
  resolveItem(node: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value;
  /** Refuses a value that is not a boolean, naming `who` in the error. */
  boolean(node: AttributeValue, who: string, state: State, context: Context | undefined, reading: Reading): Value;
  /** Reads only the type a part will have. */
  byType(node: AttributeValue, context: Context | undefined, reading: Reading): Value;
}

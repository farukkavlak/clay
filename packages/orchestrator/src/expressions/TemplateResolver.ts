import { isUnknown, State, types } from '@clay/contracts';
import { AttributeValue, ConfigError, nameOf, TemplatePart } from '@clay/parser';

import { Context } from '../keys';
import { article, described, hasText, Value, valueOf, withSensitive } from '../values/Value';
import { wholeOf } from '../values/sensitive';
import { unknownOf, UnresolvedReferenceError } from './UnresolvedReferenceError';
import { Evaluator, Reading } from './Evaluator';

/** A value with no name is found by where it is written. */
function spelledPart(part: AttributeValue): string {
  return nameOf(part) ?? "The value inside '${'";
}

/** Reads a string with interpolations into it. */
export class TemplateResolver {
  constructor(private readonly evaluate: Evaluator) {}

  /** A lone interpolation keeps its value and type; with any text it becomes a string, unknown if any part is, and sensitive if any part is. */
  resolveTemplate(parts: TemplatePart[], state: State, context: Context | undefined, reading: Reading): Value {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.evaluate.resolveIn(first, state, context, reading);

    // Every part is resolved, so an error after an unknown part is still found.
    const unresolved: UnresolvedReferenceError[] = [];
    const texts = parts.map((part) => (typeof part === 'string' ? valueOf(types.string, part) : this.textOf(part, state, context, reading, unresolved)));
    const sensitive = wholeOf(...texts);
    if (unresolved.length > 0) throw new UnresolvedReferenceError(unresolved[0].message, types.string, sensitive);

    return withSensitive(valueOf(types.string, texts.map((text) => String(text.data)).join('')), sensitive);
  }

  /** Collects an unknown part into `unresolved`. */
  private textOf(part: AttributeValue, state: State, context: Context | undefined, reading: Reading, unresolved: UnresolvedReferenceError[]): Value {
    try {
      const text = this.joined(part, state, context, reading);
      // A condition or an operator gives a value not known yet where a reference would throw.
      if (isUnknown(text.data)) unresolved.push(new UnresolvedReferenceError('A part of the string is known only after apply'));
      return text;
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(error);
      return unknownOf(error);
    }
  }

  /** Only a string, a number or a boolean can be joined. */
  private joined(part: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    const resolved = this.resolvedPart(part, state, context, reading);
    if (resolved.data === null || !hasText(resolved.type)) throw this.unjoinable(part, described(resolved));

    return resolved;
  }

  /** A value not known yet is checked by the type it will have. */
  private resolvedPart(part: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    try {
      return this.evaluate.resolveIn(part, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError) || hasText(error.type) || error.type.kind === 'dynamic') throw error;
      throw this.unjoinable(part, article(error.type.kind));
    }
  }

  private unjoinable(part: AttributeValue, what: string): ConfigError {
    return new ConfigError(`${spelledPart(part)} is ${what} and cannot be joined into a string`, part.position);
  }
}

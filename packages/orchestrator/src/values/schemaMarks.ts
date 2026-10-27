import { AttributePath, MAYBE, Schema } from '@clay/contracts';

import { mayBeSensitive, sensitiveAmong, sensitiveOf, Value, withSensitive } from './Value';
import { isSensitive } from './sensitive';

/** The attributes the schema marks, for certain or only as ones that may be, by what the values given hold. */
interface Marked {
  certain: string[];
  maybe: string[];
}

/**
 * An attribute the schema marks is sensitive whether the configuration gives it or the provider computes it, and so is one made from an attribute `marks` reaches.
 * One made only from attributes that may be sensitive may be so too.
 */
export function schemaMarked(schema: Schema, given: Record<string, Value>): Marked {
  const reached = (name: string, maybe: boolean) => Object.hasOwn(given, name) && (maybe ? mayBeSensitive : isSensitive)(given[name]);
  const by = (maybe: boolean) =>
    Object.entries(schema)
      .filter(([, { sensitive, sensitiveWith = [] }]) => (!maybe && sensitive === true) || sensitiveWith.some((other) => reached(other, maybe)))
      .map(([name]) => name);
  const certain = by(false);

  return { certain, maybe: by(true).filter((name) => !certain.includes(name)) };
}

/** The marks of the values given, with the whole of each attribute the schema marks in place of its parts, and the whole as one that may be where it may be. */
export function marksOf(schema: Schema, given: Record<string, Value>): AttributePath[] {
  const marks = sensitiveAmong(given);
  const { certain, maybe } = schemaMarked(schema, given);
  const wholes = [...certain.map((name): AttributePath => [name]), ...maybe.map((name): AttributePath => [name, MAYBE])];

  return [...wholes, ...marks.filter(([name]) => !certain.includes(String(name)))];
}

/** The values with each attribute the schema marks, given these values, sensitive as a whole, or as one that may be. */
export function schemaRemarked(schema: Schema, values: Record<string, Value>, given: Record<string, Value>): Record<string, Value> {
  const { certain, maybe } = schemaMarked(schema, given);
  const remarked = (name: string, value: Value) => {
    if (certain.includes(name)) return withSensitive(value, [[]]);

    return maybe.includes(name) ? withSensitive(value, [...sensitiveOf(value), [MAYBE]]) : value;
  };

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, remarked(name, value)]));
}

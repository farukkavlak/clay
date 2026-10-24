import { AttributePath, isMaybe, MAYBE, Schema } from '@clay/contracts';

import { sensitiveAmong, Value, withSensitive } from './Value';

/** The attributes the schema marks, for certain or only as ones that may be, by what `marks` reach. */
interface Marked {
  certain: string[];
  maybe: string[];
}

/**
 * An attribute the schema marks is sensitive whether the configuration gives it or the provider computes it, and so is one made from an attribute `marks` reaches.
 * One made only from attributes that may be sensitive may be so too.
 */
export function schemaMarked(schema: Schema, marks: readonly AttributePath[]): Marked {
  const reached = (name: string, maybe: boolean) => marks.some((path) => path[0] === name && isMaybe(path) === maybe);
  const by = (maybe: boolean) =>
    Object.entries(schema)
      .filter(([, { sensitive, sensitiveWith = [] }]) => (!maybe && sensitive === true) || sensitiveWith.some((other) => reached(other, maybe)))
      .map(([name]) => name);
  const certain = by(false);

  return { certain, maybe: by(true).filter((name) => !certain.includes(name)) };
}

/** `marks`, with the whole of each attribute the schema marks in place of its parts, and the whole as one that may be where it may be. */
export function withSchemaMarks(schema: Schema, marks: AttributePath[]): AttributePath[] {
  const { certain, maybe } = schemaMarked(schema, marks);
  const wholes = [...certain.map((name): AttributePath => [name]), ...maybe.map((name): AttributePath => [name, MAYBE])];

  return [...wholes, ...marks.filter(([name]) => !certain.includes(String(name)))];
}

/** The steps to each sensitive part of the values given, and the whole of each attribute the schema marks. */
export function marksOf(schema: Schema, given: Record<string, Value>): AttributePath[] {
  return withSchemaMarks(schema, sensitiveAmong(given));
}

/** The values with each attribute the schema marks, given these values, sensitive as a whole, or as one that may be. */
export function schemaRemarked(schema: Schema, values: Record<string, Value>, given: Record<string, Value>): Record<string, Value> {
  const { certain, maybe } = schemaMarked(schema, sensitiveAmong(given));
  const remarked = (name: string, value: Value) => {
    if (certain.includes(name)) return withSensitive(value, [[]]);

    return maybe.includes(name) ? withSensitive(value, [...(value.sensitive ?? []), [MAYBE]]) : value;
  };

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, remarked(name, value)]));
}

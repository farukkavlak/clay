import { AttributePath, Schema } from '@clay/contracts';

import { sensitiveAmong, Value, withSensitive } from './Value';

/** An attribute the schema marks is sensitive whether the configuration gives it or the provider computes it, and so is one made from an attribute `marks` reaches. */
export function schemaMarked(schema: Schema, marks: readonly AttributePath[]): string[] {
  const reached = (name: string) => marks.some(([at]) => at === name);

  return Object.entries(schema)
    .filter(([, { sensitive, sensitiveWith = [] }]) => sensitive === true || sensitiveWith.some((other) => reached(other)))
    .map(([name]) => name);
}

/** `marks`, with the whole of each attribute the schema marks in place of its parts. */
export function withSchemaMarks(schema: Schema, marks: AttributePath[]): AttributePath[] {
  const marked = schemaMarked(schema, marks);
  const wholes = marked.map((name): AttributePath => [name]);

  return [...wholes, ...marks.filter(([name]) => !marked.includes(String(name)))];
}

/** The steps to each sensitive part of the values given, and the whole of each attribute the schema marks. */
export function marksOf(schema: Schema, given: Record<string, Value>): AttributePath[] {
  return withSchemaMarks(schema, sensitiveAmong(given));
}

/** The values with each attribute the schema marks, given these values, sensitive as a whole. */
export function schemaRemarked(schema: Schema, values: Record<string, Value>, given: Record<string, Value>): Record<string, Value> {
  const whole = new Set(schemaMarked(schema, sensitiveAmong(given)));

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, whole.has(name) ? withSensitive(value, [[]]) : value]));
}

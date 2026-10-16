import { AttributePath, Schema } from '@clay/contracts';

import { sensitiveAmong, Value, withSensitive } from './Value';

/** An attribute the schema marks is sensitive whether the configuration gives it or the provider computes it. */
export function schemaMarked(schema: Schema): string[] {
  return Object.entries(schema)
    .filter(([, { sensitive }]) => sensitive === true)
    .map(([name]) => name);
}

/** The steps to each sensitive part of the values given, and the whole of each attribute the schema marks. */
export function marksOf(schema: Schema, given: Record<string, Value>): AttributePath[] {
  const marked = schemaMarked(schema);
  const wholes = marked.map((name): AttributePath => [name]);

  return [...wholes, ...sensitiveAmong(given).filter(([name]) => !marked.includes(String(name)))];
}

/** The values with each attribute the schema marks sensitive as a whole. */
export function schemaRemarked(schema: Schema, values: Record<string, Value>): Record<string, Value> {
  const whole = new Set(schemaMarked(schema));

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, whole.has(name) ? withSensitive(value, [[]]) : value]));
}

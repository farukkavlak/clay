import { AttributeValue, CONFIG_FILE, ModuleBlock, Position, ResourceBlock, Step, VariableBlock } from '@clay/parser';

/** A node a test builds by hand was never written in a file, so one place stands in for all of them. */
const position: Position = { file: CONFIG_FILE, line: 1, column: 1 };

export const str = (value: string): AttributeValue => ({ type: 'String', value, position });
/** A string is a step after a dot, a number an index; a string key in brackets is passed as { key }. */
export const steps = (...parts: (string | number | Step)[]): Step[] =>
  parts.map((part) => (typeof part === 'object' ? part : typeof part === 'number' ? { key: part } : { name: part }));

export const ref = (...parts: string[]): AttributeValue => ({ type: 'Reference', value: steps(...parts), position });

export const resourceBlock = (resourceType: string, name: string, attributes: Record<string, AttributeValue> = {}): ResourceBlock => ({
  type: 'Resource',
  resourceType,
  name,
  attributes,
  position,
});

export const variableBlock = (name: string, attributes: Record<string, AttributeValue>): VariableBlock => ({ type: 'Variable', name, attributes, position });

export const moduleBlock = (name: string, attributes: Record<string, AttributeValue>): ModuleBlock => ({ type: 'Module', name, attributes, position });

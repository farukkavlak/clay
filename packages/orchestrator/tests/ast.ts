import { AttributeValue, CONFIG_FILE, ModuleBlock, Range, ResourceBlock, VariableBlock } from '@clay/parser';

/** A node a test builds by hand was never written in a file, so one place stands in for all of them. */
const range: Range = { file: CONFIG_FILE, line: 1, column: 1 };

export const str = (value: string): AttributeValue => ({ type: 'String', value, range });
export const ref = (...parts: string[]): AttributeValue => ({ type: 'Reference', value: parts, range });

export const resourceBlock = (resourceType: string, name: string, attributes: Record<string, AttributeValue> = {}): ResourceBlock => ({
  type: 'Resource',
  resourceType,
  name,
  attributes,
  range,
});

export const variableBlock = (name: string, attributes: Record<string, AttributeValue>): VariableBlock => ({ type: 'Variable', name, attributes, range });

export const moduleBlock = (name: string, attributes: Record<string, AttributeValue>): ModuleBlock => ({ type: 'Module', name, attributes, range });

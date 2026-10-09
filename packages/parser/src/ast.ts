import { ExactNumber, Type } from '@clay/contracts';
import { Position } from './Position';
import { spellReference, spellSteps, Step } from './reference';

/** The config file name, for the root and every module. */
export const CONFIG_FILE = 'main.clay';

interface Node {
  position: Position;
}

export type ReferenceNode = Node & { type: 'Reference'; value: Step[] };

/** `path` is the steps after the call, as in `tolist(x)[0]`. */
export type CallNode = Node & { type: 'Call'; name: string; args: AttributeValue[]; path: Step[] };

/** A name bound by a `for`, then the steps after it. */
export type BoundNode = Node & { type: 'Bound'; value: Step[] };

/**
 * `[for key, value in collection : body]`, or `{for … : key => body}` for an object.
 * With `grouped` (`body...`), the values of one key are collected into a tuple.
 */
export type ForNode = Node & { type: 'For'; keyName?: string; valueName: string; collection: AttributeValue; key?: AttributeValue; body: AttributeValue; grouped?: true };

export type TemplatePart = string | ReferenceNode | CallNode | BoundNode;

export type AttributeValue =
  | (Node & { type: 'String'; value: string })
  | (Node & { type: 'Template'; value: TemplatePart[] })
  | (Node & { type: 'Number'; value: ExactNumber })
  | (Node & { type: 'Boolean'; value: boolean })
  | (Node & { type: 'Null' })
  | ReferenceNode
  | CallNode
  | BoundNode
  | ForNode
  | (Node & { type: 'List'; value: AttributeValue[] })
  | (Node & { type: 'Map'; value: Record<string, AttributeValue> });

export interface ResourceBlock extends Node {
  type: 'Resource';
  resourceType: string;
  name: string;
  /** Read by the engine, never sent to the provider. */
  count?: AttributeValue;
  /** Read by the engine, never sent to the provider. */
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
}

export interface VariableBlock extends Node {
  type: 'Variable';
  name: string;
  attributes: Record<string, AttributeValue>;
  /** Without one, a value is taken as it is. */
  valueType?: Type;
  defaults?: TypeDefaults;
}

/** The defaults of `optional(type, default)`, nested the way the type is. */
export interface TypeDefaults {
  /** By attribute name, at this level. */
  values?: Record<string, AttributeValue>;
  /** Defaults for a list's, set's or map's element. */
  element?: TypeDefaults;
  /** A tuple's items by position, or an object's attributes by name. */
  within?: Record<string, TypeDefaults>;
}

export interface OutputBlock extends Node {
  type: 'Output';
  name: string;
  value: AttributeValue;
  /** Without one, a value is taken as it is. */
  valueType?: Type;
  defaults?: TypeDefaults;
}

export interface DataBlock extends Node {
  type: 'Data';
  dataSourceType: string;
  name: string;
  /** Read by the engine, never sent to the provider. */
  count?: AttributeValue;
  /** Read by the engine, never sent to the provider. */
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
}

export interface ModuleBlock extends Node {
  type: 'Module';
  name: string;
  /** Read by the engine, never passed as an input. */
  count?: AttributeValue;
  /** Read by the engine, never passed as an input. */
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
}

/** One name of a `locals` block, so the names of several blocks are told apart like any other statements. */
export interface LocalBlock extends Node {
  type: 'Local';
  name: string;
  value: AttributeValue;
}

export type Statement = ResourceBlock | VariableBlock | OutputBlock | DataBlock | ModuleBlock | LocalBlock;
export type Program = Statement[];

/** `resource "local_file" "a"`, `module "m"`. */
export function spell(statement: Statement): string {
  if (statement.type === 'Resource') return `resource "${statement.resourceType}" "${statement.name}"`;
  if (statement.type === 'Data') return `data "${statement.dataSourceType}" "${statement.name}"`;
  return `${statement.type.toLowerCase()} "${statement.name}"`;
}

/** Direct children only. */
function valuesIn(value: AttributeValue): AttributeValue[] {
  if (value.type === 'List') return value.value;
  if (value.type === 'Call') return value.args;
  if (value.type === 'For') return [value.collection, ...(value.key ? [value.key] : []), value.body];
  if (value.type === 'Map') return Object.values(value.value);
  if (value.type === 'Template') return value.value.filter((part) => typeof part !== 'string');

  return [];
}

/** At any depth, an outer call before those in its arguments. */
export function namedIn(value: AttributeValue): (ReferenceNode | CallNode)[] {
  const inside = valuesIn(value).flatMap((item) => namedIn(item));

  return value.type === 'Reference' || value.type === 'Call' ? [value, ...inside] : inside;
}

export function callsIn(value: AttributeValue): CallNode[] {
  return namedIn(value).filter((node) => node.type === 'Call');
}

/** For messages: `var.names[0]`, `length(...)`. */
export function spellNamed(node: ReferenceNode | CallNode | BoundNode): string {
  return node.type === 'Call' ? `${node.name}(...)${spellSteps(node.path)}` : spellReference(node.value);
}

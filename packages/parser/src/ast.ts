import { ExactNumber } from '@clay/contracts';
import { Position } from './Position';
import { spellReference, spellSteps, Step } from './reference';

/** Every configuration lives under this name, the root one and a module's alike. */
export const CONFIG_FILE = 'main.clay';

/** Every node remembers where it was written, so an error about it can point at the source. */
interface Node {
  position: Position;
}

export type ReferenceNode = Node & { type: 'Reference'; value: Step[] };

/** A function called with its arguments, `length(var.names)`, and the steps written after it, read into what it gives. */
export type CallNode = Node & { type: 'Call'; name: string; args: AttributeValue[]; path: Step[] };

/** A name a `for` gives each item, read in its body, and the steps written after it. */
export type BoundNode = Node & { type: 'Bound'; value: Step[] };

/**
 * `[for key, value in collection : body]`: the body read once for each item, with the names given to the item.
 * `{for … : key => body}` makes an object instead, `key` read for each item too; with `grouped`, `body...`, the items of one key go in a tuple under it.
 */
export type ForNode = Node & { type: 'For'; keyName?: string; valueName: string; collection: AttributeValue; key?: AttributeValue; body: AttributeValue; grouped?: true };

/** A piece of a string with `${ … }` in it: text, or the reference, the call or the name an interpolation reads. */
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
  resourceType: string; // e.g., "provider_resource"
  name: string; // e.g., "my_file"
  /** How many instances the block makes; the engine's to read, so it is no attribute a provider is sent. */
  count?: AttributeValue;
  /** The keys to make an instance for, a map's or a list's; the engine's to read, as count is. */
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
}

export interface VariableBlock extends Node {
  type: 'Variable';
  name: string; // e.g., "environment"
  attributes: Record<string, AttributeValue>;
}

export interface OutputBlock extends Node {
  type: 'Output';
  name: string;
  value: AttributeValue;
}

export interface DataBlock extends Node {
  type: 'Data';
  dataSourceType: string; // e.g., "aws_ami"
  name: string; // e.g., "ubuntu"
  attributes: Record<string, AttributeValue>;
}

export interface ModuleBlock extends Node {
  type: 'Module';
  name: string;
  /** How many instances of the module to make; the engine's to read, so it is no input. */
  count?: AttributeValue;
  /** The keys to make an instance of the module for, as a resource's for_each. */
  forEach?: AttributeValue;
  attributes: Record<string, AttributeValue>;
}

export type Statement = ResourceBlock | VariableBlock | OutputBlock | DataBlock | ModuleBlock;
export type Program = Statement[];

/** A block as the config spells it: `resource "local_file" "a"`, `module "m"`. */
export function spell(statement: Statement): string {
  if (statement.type === 'Resource') return `resource "${statement.resourceType}" "${statement.name}"`;
  if (statement.type === 'Data') return `data "${statement.dataSourceType}" "${statement.name}"`;
  return `${statement.type.toLowerCase()} "${statement.name}"`;
}

/** What a value holds one level in: a list's items, a map's values, a string's interpolations, a call's arguments and a for's collection, key and body. */
function valuesIn(value: AttributeValue): AttributeValue[] {
  if (value.type === 'List') return value.value;
  if (value.type === 'Call') return value.args;
  if (value.type === 'For') return [value.collection, ...(value.key ? [value.key] : []), value.body];
  if (value.type === 'Map') return Object.values(value.value);
  if (value.type === 'Template') return value.value.filter((part) => typeof part !== 'string');

  return [];
}

/** Every reference and call written in a value, at any depth, the outer one before those in its arguments. */
export function namedIn(value: AttributeValue): (ReferenceNode | CallNode)[] {
  const inside = valuesIn(value).flatMap((item) => namedIn(item));

  return value.type === 'Reference' || value.type === 'Call' ? [value, ...inside] : inside;
}

/** Every call written in a value, at any depth, the outer one before those in its arguments. */
export function callsIn(value: AttributeValue): CallNode[] {
  return namedIn(value).filter((node) => node.type === 'Call');
}

/** A reference, a call or a name a for gives as a message names it, a call without its arguments: `var.names[0]`, `length(...)`. */
export function spellNamed(node: ReferenceNode | CallNode | BoundNode): string {
  return node.type === 'Call' ? `${node.name}(...)${spellSteps(node.path)}` : spellReference(node.value);
}

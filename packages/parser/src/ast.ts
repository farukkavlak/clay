import { Position } from './Position';

/** Every configuration lives under this name, the root one and a module's alike. */
export const CONFIG_FILE = 'main.clay';

/** Every node remembers where it was written, so an error about it can point at the source. */
interface Node {
  position: Position;
}

export type AttributeValue =
  | (Node & { type: 'String'; value: string })
  | (Node & { type: 'Number'; value: number })
  | (Node & { type: 'Boolean'; value: boolean })
  | (Node & { type: 'Reference'; value: string[] }) // e.g., ["resource_type", "resource_name", "attribute"]
  | (Node & { type: 'List'; value: AttributeValue[] })
  | (Node & { type: 'Map'; value: Record<string, AttributeValue> });

export interface ResourceBlock extends Node {
  type: 'Resource';
  resourceType: string; // e.g., "provider_resource"
  name: string; // e.g., "my_file"
  attributes: Record<string, AttributeValue>;
}

export interface VariableBlock extends Node {
  type: 'Variable';
  name: string; // e.g., "environment"
  attributes: Record<string, AttributeValue>; // type, default, description
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

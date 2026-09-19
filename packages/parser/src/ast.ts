/** Every configuration lives under this name, the root one and a module's alike. */
export const CONFIG_FILE = 'main.clay';

export type AttributeValue =
  | { type: 'String'; value: string }
  | { type: 'Number'; value: number }
  | { type: 'Boolean'; value: boolean }
  | { type: 'Reference'; value: string[] } // e.g., ["resource_type", "resource_name", "attribute"]
  | { type: 'List'; value: AttributeValue[] }
  | { type: 'Map'; value: Record<string, AttributeValue> };

export interface ResourceBlock {
  type: 'Resource';
  resourceType: string; // e.g., "provider_resource"
  name: string; // e.g., "my_file"
  attributes: Record<string, AttributeValue>;
  modulePath?: string[];
}

export interface VariableBlock {
  type: 'Variable';
  name: string; // e.g., "environment"
  attributes: Record<string, AttributeValue>; // type, default, description
}

export interface OutputBlock {
  type: 'Output';
  name: string;
  value: AttributeValue;
}

export interface DataBlock {
  type: 'Data';
  dataSourceType: string; // e.g., "aws_ami"
  name: string; // e.g., "ubuntu"
  attributes: Record<string, AttributeValue>;
}

export interface ModuleBlock {
  type: 'Module';
  name: string;
  attributes: Record<string, AttributeValue>;
}

export type Statement = ResourceBlock | VariableBlock | OutputBlock | DataBlock | ModuleBlock;
export type Program = Statement[];

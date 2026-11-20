import { ModuleAddress } from '@clay/core';
import { AttributeValue, DataBlock, ModuleBlock, Position, ProviderBlock, ReferenceNode, spellProvider } from '@clay/parser';

import { dataSourceAddress, ModuleCall } from '../keys';
import { Declared } from '../values/declared';

/** The module as written, not an instance; a node runs once per instance. A module call sits in its caller. */
interface InModule {
  module: ModuleAddress;
}

/** `context` is where the value is read, not where it is declared: a module input is read in the call. */
export interface ValueNode extends InModule {
  name: string;
  value: AttributeValue | undefined;
  context: ModuleAddress | ModuleCall;
  position: Position;
  declaration: string;
}

/** An output always has a value; a variable may not until a call gives it one. */
export type OutputNode = ValueNode & { value: AttributeValue; declared: Declared; dependsOn?: ReferenceNode[] };

export type LocalNode = ValueNode & { value: AttributeValue };

const SPELLED = { variable: 'var', local: 'local', output: 'output' };

export type GraphNode =
  /** `alias` is the provider instance its block takes, left out for the default one. */
  | ({ kind: 'resource'; alias?: string } & InModule)
  | ({ kind: 'variable' } & ValueNode)
  | ({ kind: 'local' } & LocalNode)
  | ({ kind: 'output' } & OutputNode)
  | ({ kind: 'module'; block: ModuleBlock } & InModule)
  /** `alias` as on a resource. */
  | ({ kind: 'data'; block: DataBlock; alias?: string } & InModule)
  /** The resource types it makes, so an object of one is destroyed after it is configured; `block` where the configuration sets it. */
  | ({ kind: 'provider'; name: string; alias?: string; resources: readonly string[]; block?: ProviderBlock } & InModule);

export type DataNode = Extract<GraphNode, { kind: 'data' }>;

/** `module.m.var.x`; a resource's key already is its address. */
export function spellNode(key: string, node: GraphNode): string {
  if (node.kind === 'resource') return key;
  if (node.kind === 'module') return node.module.child(node.block.name).toString();
  if (node.kind === 'data') return dataSourceAddress(node.module.toString(), node.block.dataSourceType, node.block.name);
  if (node.kind === 'provider') return spellProvider(node.name, node.alias);

  const scope = node.module.toString();
  return `${scope ? `${scope}.` : ''}${SPELLED[node.kind]}.${node.name}`;
}

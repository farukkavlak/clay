import { Address, ModuleAddress, State } from '@clay/core';
import { Graph } from '@clay/graph';

import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { GraphNode } from './DependencyGraphBuilder';
import { providerKey } from '../keys';

/** For `passing`: the blocks are ordered by what they read, as if their provider were not there. */
export const isProvider =
  <T extends { kind: string }>(graph: Graph<T>) =>
  (key: string) =>
    graph.getNode(key)?.kind === 'provider';

/** Each object by its address, deposed ones too. */
function typesHeld(state: State): [string, string][] {
  return [
    ...Object.entries(state.resources).map(([key, { resourceType }]) => [key, resourceType] as [string, string]),
    ...Object.keys(state.deposed ?? {}).map((key) => [key, Address.parse(key).resourceType] as [string, string]),
  ];
}

/**
 * A node for each provider a block or an object in state needs, beside those a provider block made, before every block of its types, so the walk
 * configures it first. An object in state may be refreshed or destroyed with no block left. A provider nothing needs and no block sets is never
 * configured.
 */
export function addProviders(graph: Graph<GraphNode>, registry: ProviderRegistry, state: State): void {
  const add = (name: string, dependent?: string) => {
    const key = providerKey(name);
    if (!graph.hasNode(key)) graph.addNode(key, { kind: 'provider', name, resources: registry.resourcesOf(name), module: ModuleAddress.root });
    if (dependent) graph.addEdge(key, dependent);
  };

  for (const [key, node] of graph.entries()) {
    if (node.kind === 'resource') add(registry.get(Address.parse(key).resourceType).name, key);
    if (node.kind === 'data') add(registry.reader(node.block.dataSourceType).name, key);
  }
  for (const [key, type] of typesHeld(state)) {
    if (!registry.handles(type)) throw new Error(`${key}: No provider handles "${type}"`);
    add(registry.get(type).name);
  }
}

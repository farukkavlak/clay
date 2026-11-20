import { Address, ModuleAddress, State } from '@clay/core';
import { Graph } from '@clay/graph';
import { spellProvider } from '@clay/parser';

import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { GraphNode } from './DependencyGraphBuilder';
import { append } from '../append';
import { providerKey } from '../keys';

/** For `passing`: the blocks are ordered by what they read, as if their provider were not there. */
export const isProvider =
  <T extends { kind: string }>(graph: Graph<T>) =>
  (key: string) =>
    graph.getNode(key)?.kind === 'provider';

/** An object in state: its address, its type and the provider instance that made it. Deposed ones too. */
interface Held {
  key: string;
  type: string;
  alias?: string;
}

function objectsHeld(state: State): Held[] {
  return [
    ...Object.entries(state.resources).map(([key, { resourceType, alias }]) => ({ key, type: resourceType, alias })),
    ...Object.entries(state.deposed ?? {}).flatMap(([key, objects]) => objects.map(({ alias }) => ({ key, type: Address.parse(key).resourceType, alias }))),
  ];
}

type Add = (name: string, alias: string | undefined, dependent?: string) => void;

/** The blocks of each resource type, after the provider each names. */
function addForBlocks(graph: Graph<GraphNode>, registry: ProviderRegistry, add: Add): Map<string, string[]> {
  const blocksOf = new Map<string, string[]>();
  for (const [key, node] of graph.entries()) {
    if (node.kind === 'resource') {
      const type = Address.parse(key).resourceType;
      add(registry.get(type).name, node.alias, key);
      append(blocksOf, type, key);
    }
    if (node.kind === 'data') add(registry.reader(node.block.dataSourceType).name, node.block.provider?.alias, key);
  }

  return blocksOf;
}

/**
 * A node for each provider a block or an object in state needs, beside those a provider block made, before every block of its types, so the walk
 * configures it first. An object in state may be refreshed or destroyed with no block left, by the instance that made it, so every block of
 * its type waits for that one too: a move may take it to any of them. A provider nothing needs and no block sets is never configured.
 */
export function addProviders(graph: Graph<GraphNode>, registry: ProviderRegistry, state: State): void {
  // The parser holds every alias a block names to a provider block, so only an object in state can name a missing one.
  const add: Add = (name, alias, dependent) => {
    const key = providerKey(name, alias);
    if (!graph.hasNode(key)) graph.addNode(key, { kind: 'provider', name, resources: registry.resourcesOf(name), module: ModuleAddress.root });
    if (dependent) graph.addEdge(key, dependent);
  };

  const blocksOf = addForBlocks(graph, registry, add);
  for (const { key, type, alias } of objectsHeld(state)) {
    if (!registry.handles(type)) throw new Error(`${key}: No provider handles "${type}"`);

    const { name } = registry.get(type);
    if (alias !== undefined && !graph.hasNode(providerKey(name, alias)))
      throw new Error(`${key}: ${spellProvider(name, alias)} made it, but the configuration declares no such block, so nothing can refresh or destroy it`);
    for (const block of blocksOf.get(type) ?? [undefined]) add(name, alias, block);
  }
}

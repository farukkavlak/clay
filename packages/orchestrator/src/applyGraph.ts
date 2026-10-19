import { Address, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { PlanAction } from '@clay/planner';

import { GraphNode, spellNode } from './components/DependencyGraphBuilder';
import { blockKey } from './keys';

/** An object destroyed apart from its block: a delete, a deposed object, the old object of a create-first replace, or a replace's old object that has to go before its turn. */
export interface DestroyNode {
  kind: 'destroy';
  action: PlanAction;
}

export type ApplyNode = GraphNode | DestroyNode;

/** What a replace left behind is destroyed apart from the resource it was left by, which may be destroyed too. */
const deposedKey = (address: string) => `${address} (deposed)`;

/** A resource's key has no `:`, so this is apart from every block. */
const destroyKey = (object: string) => `destroy:${object}`;

/** One object going away, and what it read, by the dependencies in state. */
interface Going {
  action: PlanAction;
  reads: string[];
  /** The block of a replace that makes the new object first, which leaves this one deposed. */
  madeBy?: string;
}

const isPlainReplace = (action: PlanAction) => action.type === 'REPLACE' && !action.createBeforeDestroy;

/** Its key, and what it read: a replace that makes the new object first leaves the current one deposed beside any left before. */
function goingOf(action: PlanAction, state: State): [string, Going] | undefined {
  const address = Address.of(action);
  const key = address.toString();
  const current = state.resources[key]?.dependencies ?? [];
  const left = (state.deposed?.[key] ?? []).flatMap((object) => object.dependencies ?? []);

  if (action.type === 'REPLACE' && action.createBeforeDestroy)
    return [deposedKey(key), { action: { type: 'DELETE', deposed: true, ...address.fields() }, reads: [...left, ...current], madeBy: blockKey(address) }];
  if (action.type === 'REPLACE') return [key, { action, reads: current }];
  if (action.type !== 'DELETE') return undefined;

  return action.deposed ? [deposedKey(key), { action, reads: left }] : [key, { action, reads: current }];
}

/** By its address, with ` (deposed)` for what replaces left behind, before this run or in it. */
function goingObjects(actions: PlanAction[], state: State): Map<string, Going> {
  const going = new Map<string, Going>();

  for (const action of actions) {
    const entry = goingOf(action, state);
    if (entry && (entry[1].madeBy || !going.has(entry[0]))) going.set(...entry);
  }

  return going;
}

function reaches(next: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];

  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (at === to) return true;

    for (const step of next.get(at) ?? [])
      if (!seen.has(step)) {
        seen.add(step);
        queue.push(step);
      }
  }

  return false;
}

/**
 * Each object to the ones it reads, which are destroyed after it. A resource that depends on an address waits for its deposed objects too.
 * Objects left at different times can name each other, which no order holds, so a read that would close a loop is dropped.
 */
function readsAmong(going: Map<string, Going>): Map<string, string[]> {
  const next = new Map<string, string[]>();

  for (const [key, { reads }] of going)
    for (const dependency of reads)
      for (const read of [dependency, deposedKey(dependency)]) {
        if (!going.has(read) || reaches(next, read, key)) continue;

        next.set(key, [...(next.get(key) ?? []), read]);
      }

  return next;
}

/** What reads a replace that destroys its object before making the new one, or reads what does. Each has to be destroyed before that replace. */
function beforeReplaces(going: Map<string, Going>, next: Map<string, string[]>): Set<string> {
  const readBy = new Map<string, string[]>();
  for (const [key, reads] of next) for (const read of reads) readBy.set(read, [...(readBy.get(read) ?? []), key]);

  const found = new Set<string>();
  const queue = [...going].filter(([, { action }]) => isPlainReplace(action)).map(([key]) => key);

  for (let at = queue.shift(); at !== undefined; at = queue.shift())
    for (const reader of readBy.get(at) ?? [])
      if (!found.has(reader)) {
        found.add(reader);
        queue.push(reader);
      }

  return found;
}

/**
 * The blocks of what stays and reads each address, by the plan or by state.
 * A new object reads what is there when it is made, and a replace's old object is ordered among the objects going away.
 */
function readersByAddress(actions: PlanAction[], state: State): Map<string, Set<string>> {
  const readers = new Map<string, Set<string>>();

  for (const action of actions) {
    if (action.type !== 'UPDATE' && action.type !== 'NO_OP') continue;

    const address = Address.of(action);
    const held = state.resources[address.toString()]?.dependencies ?? [];
    for (const read of [...(action.dependencies ?? []), ...held]) readers.set(read, (readers.get(read) ?? new Set()).add(blockKey(address)));
  }

  return readers;
}

function addDestroy(graph: Graph<ApplyNode>, key: string, { action, madeBy }: Going): void {
  graph.addNode(destroyKey(key), { kind: 'destroy', action });
  if (isPlainReplace(action)) graph.addEdge(destroyKey(key), blockKey(Address.of(action)));
  if (madeBy) graph.addEdge(madeBy, destroyKey(key));
}

function addWaits(graph: Graph<ApplyNode>, going: Map<string, Going>, first: Set<string>, readers: Map<string, Set<string>>): void {
  for (const [key, { action, madeBy }] of going) {
    if (action.type !== 'DELETE' || (first.has(key) && !madeBy)) continue;

    for (const reader of readers.get(Address.of(action).toString()) ?? []) graph.addEdge(reader, destroyKey(key));
  }
}

function spellApply(key: string, node: ApplyNode): string {
  if (node.kind !== 'destroy') return spellNode(key, node);

  const address = Address.of(node.action).toString();
  return node.action.deposed ? `destroying the old ${address}` : `destroying ${address}`;
}

/** Each step waits for the next. */
function refuseLoop(graph: Graph<ApplyNode>): void {
  const loop = graph.findCycle()?.map((key) => spellApply(key, graph.getNode(key)!));
  if (loop) throw new Error(`No order applies this plan: ${loop[0]} waits for ${loop.slice(1).join(', which waits for ')}`);
}

/**
 * The configuration's graph, with a node for each object destroyed apart from its block.
 * A replace whose object reads nothing it has to go before is destroyed by its block, after what the block reads, so the new values are checked before the old object goes.
 * A destroy that reads nothing a replace needs gone first waits for what reads it to be updated, so nothing outlives what it reads. These waits never close a loop:
 * such a destroy leads only to destroys that lead to no block.
 * The old object of a replace that makes the new one first always waits for what stays and reads it. A loop there is refused before anything runs.
 */
export function applyGraph(config: Graph<GraphNode>, actions: PlanAction[], state: State): Graph<ApplyNode> {
  const graph = new Graph<ApplyNode>();
  for (const [key, node] of config.entries()) graph.addNode(key, node);
  for (const [key] of config.entries()) for (const dependent of config.dependentsOf(key)) graph.addEdge(key, dependent);

  const going = goingObjects(actions, state);
  const next = readsAmong(going);
  const first = beforeReplaces(going, next);
  const byBlock = (key: string) => isPlainReplace(going.get(key)!.action) && !first.has(key);
  const nodeOf = (key: string) => (byBlock(key) ? blockKey(Address.of(going.get(key)!.action)) : destroyKey(key));

  for (const [key, object] of going) if (!byBlock(key)) addDestroy(graph, key, object);
  for (const [key, reads] of next) for (const read of reads) graph.addEdge(nodeOf(key), nodeOf(read));
  addWaits(graph, going, first, readersByAddress(actions, state));
  refuseLoop(graph);

  return graph;
}

import { Address, covers, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { spell } from '@clay/parser';
import { PlanAction } from '@clay/planner';

import { GraphNode, spellNode } from '../graph/DependencyGraphBuilder';
import { ConfiguredResource } from './DesiredStateBuilder';
import { append } from '../append';
import { blockKey } from '../keys';
import { withPlace } from '../place';

/** An object destroyed apart from its block: a delete, a deposed object, the old object of a create-first replace, or a replace's old object that has to go before its turn. */
export interface DestroyNode {
  kind: 'destroy';
  action: PlanAction;
}

/** Between the readers of a dependency and the objects it covers, so n readers of n objects take 2n edges, not n². */
export interface WaitNode {
  kind: 'wait';
}

export type ApplyNode = GraphNode | DestroyNode | WaitNode;

/** What a replace left behind is destroyed apart from the resource it was left by, which may be destroyed too. */
const deposedKey = (address: string) => `${address} (deposed)`;

/** A resource's key has no `:`, so this is apart from every block. */
const destroyKey = (object: string) => `destroy:${object}`;

const waitKey = (dependency: string) => `wait:${dependency}`;

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

function reaches(stepsFrom: (at: string) => string[], from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];

  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (at === to) return true;

    for (const step of stepsFrom(at))
      if (!seen.has(step)) {
        seen.add(step);
        queue.push(step);
      }
  }

  return false;
}

/** The keys of the objects going away, by their block, so a dependency is held against its own block's objects only. */
function goingByBlock(going: Map<string, Going>): Map<string, string[]> {
  const byBlock = new Map<string, string[]>();
  for (const [key, { action }] of going) {
    const block = blockKey(Address.of(action));
    append(byBlock, block, key);
  }

  return byBlock;
}

/** Whether objects of the block `reader` and of the block it read can read each other, by the blocks the objects going away read. */
function loopsAmong(going: Map<string, Going>, byBlock: Map<string, string[]>): (reader: string, read: string) => boolean {
  const blocks = new Graph<null>();
  for (const block of byBlock.keys()) blocks.addNode(block, null);
  for (const { action, reads } of going.values())
    for (const read of reads.map((dependency) => blockKey(Address.parse(dependency)))) if (blocks.hasNode(read)) blocks.addEdge(blockKey(Address.of(action)), read);

  const components = blocks.components();
  return (reader, read) => components.get(reader) === components.get(read);
}

/** Each object `key` reads, but one that reads `key` already. */
function readEach(next: Map<string, string[]>, key: string, reads: string[]): void {
  for (const read of reads) if (!reaches((at) => next.get(at) ?? [], read, key)) append(next, key, read);
}

/**
 * Each object to the ones it reads, which are destroyed after it: every object a dependency covers, deposed ones too.
 * Objects left at different times can name each other, which no order holds, so a read that would close a loop is dropped.
 * Between blocks that cannot read each other no read closes one, so readers go through the dependency's wait node.
 */
function readsAmong(going: Map<string, Going>): Map<string, string[]> {
  const byBlock = goingByBlock(going);
  const loops = loopsAmong(going, byBlock);
  const next = new Map<string, string[]>();
  const coveredBy = (dependency: Address) => (byBlock.get(blockKey(dependency)) ?? []).filter((read) => covers(dependency, Address.of(going.get(read)!.action)));

  for (const [key, { action, reads }] of going)
    for (const dependency of reads) {
      const address = Address.parse(dependency);
      if (loops(blockKey(Address.of(action)), blockKey(address))) readEach(next, key, coveredBy(address));
      else {
        if (!next.has(waitKey(dependency))) next.set(waitKey(dependency), coveredBy(address));
        append(next, key, waitKey(dependency));
      }
    }

  return next;
}

/** What reads a replace that destroys its object before making the new one, or reads what does, and the wait nodes between. Each has to be destroyed before that replace. */
function beforeReplaces(going: Map<string, Going>, next: Map<string, string[]>): Set<string> {
  const readBy = new Map<string, string[]>();
  for (const [key, reads] of next) for (const read of reads) append(readBy, read, key);

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

/** By the block a dependency names, then by the dependency, the blocks of what reads through it. */
type Readers = Map<string, Map<string, Set<string>>>;

/**
 * The blocks of what stays and reads, by the plan or by state.
 * A new object reads what is there when it is made, and a replace's old object is ordered among the objects going away.
 */
function readersOfBlocks(actions: PlanAction[], state: State): Readers {
  const readers: Readers = new Map();

  for (const action of actions) {
    if (action.type !== 'UPDATE' && action.type !== 'NO_OP') continue;

    const address = Address.of(action);
    const held = state.resources[address.toString()]?.dependencies ?? [];
    for (const read of [...(action.dependencies ?? []), ...held]) {
      const block = blockKey(Address.parse(read));
      const byDependency = readers.get(block) ?? new Map<string, Set<string>>();
      readers.set(block, byDependency.set(read, (byDependency.get(read) ?? new Set()).add(blockKey(address))));
    }
  }

  return readers;
}

/** The blocks of what stays and reads the object at `address`. */
function readersOf(readers: Readers, address: Address): string[] {
  const found = new Set<string>();
  for (const [dependency, blocks] of readers.get(blockKey(address)) ?? []) if (covers(Address.parse(dependency), address)) for (const block of blocks) found.add(block);

  return [...found];
}

function addDestroy(graph: Graph<ApplyNode>, key: string, { action, madeBy }: Going): void {
  graph.addNode(destroyKey(key), { kind: 'destroy', action });
  if (isPlainReplace(action)) graph.addEdge(destroyKey(key), blockKey(Address.of(action)));
  if (madeBy) graph.addEdge(madeBy, destroyKey(key));
}

/** `from` and every node it reaches by `stepsFrom`. */
function reachedFrom(stepsFrom: (at: string) => string[], from: string): Set<string> {
  const seen = new Set([from]);
  const stack = [from];

  for (let at = stack.pop(); at !== undefined; at = stack.pop())
    for (const step of stepsFrom(at))
      if (!seen.has(step)) {
        seen.add(step);
        stack.push(step);
      }

  return seen;
}

/**
 * What stays and reads an object is updated before the node that destroys it.
 * The old object of a create-first replace waits first, always. Any other wait that would close a loop is dropped: what stays reads the replace the object goes before.
 * A wait to a node that does not reach its reader opens no way into the reader, so what reaches a reader is found once for all its waits.
 */
function addWaits(graph: Graph<ApplyNode>, going: Map<string, Going>, nodeOf: (key: string) => string, readers: Readers): void {
  const waits = [...going].flatMap(([key, { action, madeBy }]) => readersOf(readers, Address.of(action)).map((reader) => ({ reader, node: nodeOf(key), madeBy })));
  for (const { reader, node } of waits.filter(({ madeBy }) => madeBy)) graph.addEdge(reader, node);

  const byReader = new Map<string, string[]>();
  for (const { reader, node } of waits.filter(({ madeBy }) => !madeBy)) append(byReader, reader, node);

  for (const [reader, nodes] of byReader) {
    const reaching = reachedFrom((at) => graph.dependenciesOf(at), reader);
    for (const node of nodes) if (!reaching.has(node)) graph.addEdge(reader, node);
  }
}

function spellApply(key: string, node: GraphNode | DestroyNode): string {
  if (node.kind !== 'destroy') return spellNode(key, node);

  const address = Address.of(node.action).toString();
  return node.action.deposed ? `destroying the old ${address}` : `destroying ${address}`;
}

/** Every loop runs through the old object of a create-first replace, so its block is where to break it. */
export class NoApplyOrder extends Error {
  constructor(
    message: string,
    readonly createFirst: Address
  ) {
    super(message);
    this.name = 'NoApplyOrder';
  }
}

/** Each step waits for the next. A wait node runs nothing, so it is no step; every loop holds an object or a block. */
function refuseLoop(graph: Graph<ApplyNode>, going: Map<string, Going>): void {
  const loop = graph.findCycle();
  if (!loop) return;

  const steps = loop.slice(0, -1).flatMap((key) => {
    const node = graph.getNode(key)!;
    return node.kind === 'wait' ? [] : [spellApply(key, node)];
  });
  const message = `No order applies this plan: ${steps[0]} waits for ${[...steps.slice(1), steps[0]].join(', which waits for ')}`;
  const createFirst = [...going].find(([key, { madeBy }]) => madeBy && loop.includes(destroyKey(key)));
  if (!createFirst) throw new Error(message);

  throw new NoApplyOrder(message, Address.of(createFirst[1].action));
}

/**
 * The configuration's graph, with a node for each object destroyed apart from its block.
 * A replace whose object reads nothing it has to go before is destroyed by its block, after what the block reads, so the new values are checked before the old object goes.
 * Every object going away waits for what stays and reads it to be updated, so nothing outlives what it reads, unless what stays needs the replace made first.
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
  // A key in `next` that is no object going away is a wait node.
  const isWait = (key: string) => !going.has(key);
  const nodeOf = (key: string) => {
    if (isWait(key)) return key;

    return byBlock(key) ? blockKey(Address.of(going.get(key)!.action)) : destroyKey(key);
  };

  for (const [key, object] of going) if (!byBlock(key)) addDestroy(graph, key, object);
  for (const key of next.keys()) if (isWait(key)) graph.addNode(key, { kind: 'wait' });
  for (const [key, reads] of next) for (const read of reads) graph.addEdge(nodeOf(key), nodeOf(read));
  addWaits(graph, going, nodeOf, readersOfBlocks(actions, state));
  refuseLoop(graph, going);

  return graph;
}

/** Run at plan too, so a loop is refused before the plan is approved, at the block to change. */
export function checkApplyOrder(config: Graph<GraphNode>, actions: PlanAction[], state: State, desired: ConfiguredResource[]): void {
  try {
    applyGraph(config, actions, state);
  } catch (error) {
    if (!(error instanceof NoApplyOrder)) throw error;

    // A create-first replace is planned from its block, so the block is there.
    const found = desired.find((resource) => resource.address.toString() === error.createFirst.toString())!;
    throw withPlace(error, found.block.position, spell(found.block), found.address.module);
  }
}

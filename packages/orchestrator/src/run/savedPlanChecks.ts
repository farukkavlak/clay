import { Address, ModuleAddress, Output, parseDataAddress, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { OutputBlock, spell, Statement } from '@clay/parser';
import { Plan, PlanAction } from '@clay/planner';

import { GraphNode } from '../graph/DependencyGraphBuilder';
import { Instances, repetitionOfKey } from '../instances/Instances';
import { blockKey, dataSourceKey, scopeOf } from '../keys';
import { withPlace } from '../place';

export type Approved = Pick<Plan, 'actions' | 'imported' | 'outputs' | 'dataSources' | 'dataSensitive' | 'readAtApply'>;

/** What a root output comes to: what the plan shows, or what state holds for one the plan leaves as it is. */
export interface PlannedOutput {
  held: Output;
  inPlan: boolean;
  /** The plan printed no value for it: it is sensitive, or was until this plan. */
  hidden: boolean;
}

type PlannedOutputs = Map<string, PlannedOutput>;

/** Checked against the configuration before anything runs, and used as the run goes. */
export interface Checked {
  named: Map<string, Set<string>>;
  outputs: PlannedOutputs;
}

export function undeclared(address: Address | string): Error {
  return new Error(`The plan has "${address}", which the configuration does not declare`);
}

/** A saved plan may hold an action with no block, which would be silently skipped, or a key unlike its block's, which would run another instance. */
export function checkActionsMatch(actions: PlanAction[], graph: Graph<GraphNode>, instances: Instances): void {
  for (const action of actions) {
    const address = Address.of(action);
    const block = blockKey(address);
    const declared = graph.hasNode(block) && repetitionOfKey(action.key) === instances.repetitionOf(block);

    if (action.type !== 'DELETE' && !declared) throw undeclared(address);
  }
}

/** A plan shows each output that comes, goes or changes, so the others are the ones in state. */
export function plannedOutputs({ outputs }: Approved, state: State): PlannedOutputs {
  const planned: PlannedOutputs = new Map();

  for (const [name, held] of Object.entries(state.outputs ?? {})) if (!Object.hasOwn(outputs, name)) planned.set(name, { held, inPlan: false, hidden: held.sensitive === true });
  for (const [name, { old, new: next }] of Object.entries(outputs))
    if (next !== undefined) planned.set(name, { held: next, inPlan: true, hidden: (old?.sensitive ?? next.sensitive) === true });

  return planned;
}

/** A plan that hid an output would end by printing it, or one that printed it by hiding it. */
function checkFlagMatches(stmt: OutputBlock, { held, inPlan }: PlannedOutput): void {
  if (held.sensitive === stmt.sensitive) return;

  const was = `the plan ${inPlan ? 'showed' : 'left'} ${stmt.name} as ${held.sensitive ? 'sensitive' : 'not sensitive'}`;
  throw withPlace(new Error(`${was}, but it is ${stmt.sensitive ? 'sensitive' : 'not sensitive'} now. Plan again.`), stmt.position, spell(stmt), ModuleAddress.root);
}

export function checkOutputsMatch(planned: PlannedOutputs, program: Statement[]): void {
  const declared = program.filter((stmt) => stmt.type === 'Output');

  for (const stmt of declared) {
    const output = planned.get(stmt.name);
    if (!output) throw withPlace(new Error(`The plan has no output "${stmt.name}", which the configuration declares`), stmt.position, spell(stmt), ModuleAddress.root);

    checkFlagMatches(stmt, output);
  }

  const names = new Set(declared.map((stmt) => stmt.name));
  for (const name of planned.keys()) if (!names.has(name)) throw new Error(`The plan has output "${name}", which the configuration does not declare`);
}

/** By block. A saved plan may name a data source with no block, whose value would be silently dropped. */
export function dataNamed({ dataSources, readAtApply }: Approved, graph: Graph<GraphNode>): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();

  for (const address of [...Object.keys(dataSources), ...readAtApply]) {
    const { module, type, name } = parseDataAddress(address);
    const block = dataSourceKey(scopeOf(module.withoutKeys()), type, name);
    if (!graph.hasNode(block)) throw undeclared(address);

    named.set(block, (named.get(block) ?? new Set()).add(address));
  }

  return named;
}

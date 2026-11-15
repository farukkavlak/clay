import { State } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { LockNotReleased } from '../lockInfo';
import { BackendChoice, DEFAULT_WORKSPACE, NamedWorkspace, StateBackend } from '../StateBackend';
import { StateManager } from '../StateManager';
import { LocalBackend } from './LocalBackend';
import { namedWorkspace } from './workspaces';

/** Asked before a state is moved; only true moves it. */
export type Approve = (question: string) => Promise<boolean>;

/** Runs a step that Ctrl-C may end at once, as the CLI runs one that writes nothing. */
export type Stoppable = <T>(step: () => Promise<T>) => Promise<T>;

export const unstoppable: Stoppable = (step) => step();

/** The state of a workspace `init` found at the place it took before. */
export interface MovedWorkspace {
  readonly name: string;
  /** False where the new place held the same state already. */
  readonly copied: boolean;
}

export interface Moved {
  readonly from: BackendChoice;
  /** Named workspaces first, the default one last, as they were written. */
  readonly workspaces: readonly MovedWorkspace[];
}

export interface Adopted {
  /** Unset where the old place held no state. */
  readonly moved?: Moved;
  /** Set where a lock `init` took could not be released. */
  readonly locksLeft?: readonly LockNotReleased[];
}

/** What `init` took before, and how it makes the manager of each state it locks while the states move, old or new. */
export interface Previous {
  readonly backend: StateBackend;
  readonly manage: (backend: StateBackend) => StateManager;
}

/** The state of one workspace, from the old place to the new one. */
interface Move {
  readonly name: string;
  readonly from: StateBackend;
  readonly to: StateBackend;
}

interface Planned {
  readonly move: Move;
  readonly state: State;
  readonly copy: boolean;
}

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(', ');

/** The named workspaces at the old place, refused where the new backend keeps one state, before anything is locked. */
export async function namedWorkspaces(before: StateBackend, backend: StateBackend): Promise<string[]> {
  const names = (await before.listWorkspaces?.()) ?? [DEFAULT_WORKSPACE];
  const named = names.filter((name) => name !== DEFAULT_WORKSPACE);
  if (named.length === 0 || backend.workspace !== undefined) return named;

  const { where, type } = before.choice;
  throw new Error(
    `Workspaces other than the default one are kept with "${where}" (${type}): ${quoted(named)}; backend "${backend.choice.type}" keeps one state, so delete them with \`clay workspace delete\` or keep this backend`
  );
}

/** Two places on one server may share a lock, which `init` holds already. */
const sharedLock = (a: BackendChoice, b: BackendChoice) =>
  a.type === b.type && a.settings.lock_address !== undefined && a.settings.lock_address === b.settings.lock_address && a.settings.lock_method === b.settings.lock_method;

/** The caller holds the lock of the new default state, so only the others are taken here. */
function managersOf(moves: readonly Move[], previous: Previous): StateManager[] {
  const managers: StateManager[] = [];
  for (const { name, from, to } of moves) {
    if (name !== DEFAULT_WORKSPACE) managers.push(previous.manage(to));
    if (name !== DEFAULT_WORKSPACE || !sharedLock(from.choice, to.choice)) managers.push(previous.manage(from));
  }

  return managers;
}

const journalAlone = ({ where }: BackendChoice) =>
  new Error(`"${where}" has a journal and no state, so there is nothing to move; remove ${where}.journal and run \`clay init\` again`);

/** Called under both locks. Undefined where nothing is there, as where another run removed the state since `init` looked. */
async function stateToMove(from: StateBackend): Promise<State | undefined> {
  if (await from.exists()) return from.read();
  if (from instanceof LocalBackend && (await from.holdsAnything())) throw journalAlone(from.choice);

  return undefined;
}

const ofWorkspace = (name: string) => (name === DEFAULT_WORKSPACE ? '' : ` of workspace "${name}"`);

async function planned(move: Move): Promise<Planned | undefined> {
  const state = await stateToMove(move.from);
  if (state === undefined) return undefined;
  if (!(await move.to.exists())) return { move, state, copy: true };
  // The same state is what an init stopped after the copy leaves.
  if (isDeepStrictEqual(await move.to.read(), state)) return { move, state, copy: false };

  throw new Error(
    `"${move.from.choice.where}" and "${move.to.choice.where}" both hold a state${ofWorkspace(move.name)}, and they differ; remove the one you do not want, and run \`clay init\` again`
  );
}

function statesOf(names: readonly string[]): string {
  if (names.length > 1) return `the states of workspaces ${quoted(names)}`;

  return names[0] === DEFAULT_WORKSPACE ? 'the state' : `the state of workspace "${names[0]}"`;
}

/** Every state is looked at before one is asked about or written, so a refusal leaves the new place as it was. */
async function copied(moves: readonly Move[], previous: Previous, backend: StateBackend, approve: Approve): Promise<MovedWorkspace[]> {
  const plans: Planned[] = [];
  for (const move of moves) {
    const plan = await planned(move);
    if (plan) plans.push(plan);
  }

  const copies = plans.filter(({ copy }) => copy);
  if (copies.length > 0) {
    const [from, to] = [previous.backend.choice, backend.choice];
    if (!(await approve(`Move ${statesOf(copies.map(({ move }) => move.name))} in "${from.where}" (${from.type}) to "${to.where}" (${to.type})?`)))
      throw new Error(`${copies.length === 1 ? 'The state was' : 'The states were'} not moved, and nothing changed`);
  }

  for (const { move, state } of copies) await move.to.write(state);
  return plans.map(({ move, copy }) => ({ name: move.name, copied: copy }));
}

/** Tries every lock, so one that fails leaves no other held. */
async function released(managers: readonly StateManager[]): Promise<LockNotReleased[]> {
  const left: LockNotReleased[] = [];
  for (const manager of managers)
    try {
      await manager.unlock();
    } catch (error) {
      if (!(error instanceof LockNotReleased)) throw error;

      left.push(error);
    }

  return left;
}

/** The folders made for a new workspace are cleared once their locks are released; one that holds a state is left. */
async function failedWith(failure: unknown, managers: readonly StateManager[], made: readonly NamedWorkspace[]): Promise<never> {
  const left: unknown[] = await released(managers);
  try {
    for (const workspace of made) await workspace.prune();
  } catch (pruneError) {
    // Every error is kept, so none hides the one that stopped the run.
    left.push(pruneError);
  }
  if (left.length > 0) throw new AggregateError([failure, ...left], 'The run failed, and a lock it took or a folder it made is left');

  throw failure;
}

function movesOf(named: readonly string[], before: StateBackend, backend: StateBackend): { moves: Move[]; made: NamedWorkspace[] } {
  const made = named.map((name) => namedWorkspace(backend, name));
  const moves = named.map((name, index) => ({ name, from: namedWorkspace(before, name), to: made[index] }));

  return { moves: [...moves, { name: DEFAULT_WORKSPACE, from: before, to: backend }], made };
}

/**
 * Moves every workspace under the locks of both places, held until `commit` has recorded the new place, so no run changes a state that is
 * left behind. Named ones are written first and the record last, so an `init` stopped on the way goes on where it was when run again.
 */
export async function moveStates(
  named: readonly string[],
  backend: StateBackend,
  previous: Previous,
  approve: Approve,
  stoppable: Stoppable,
  commit: () => Promise<void>
): Promise<Adopted> {
  const { moves, made } = movesOf(named, previous.backend, backend);
  const managers = managersOf(moves, previous);

  let workspaces: MovedWorkspace[];
  try {
    for (const workspace of made) await workspace.prepare?.();
    for (const manager of managers) await stoppable(() => manager.lock('init'));
    workspaces = await copied(moves, previous, backend, approve);
    await commit();
  } catch (error) {
    return await failedWith(error, managers, made);
  }

  const left = await released(managers);
  return {
    ...(workspaces.length > 0 ? { moved: { from: previous.backend.choice, workspaces } } : {}),
    ...(left.length > 0 ? { locksLeft: left } : {}),
  };
}

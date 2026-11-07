import { isRecord } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';
import * as fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { LockNotReleased } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { StateManager } from '../StateManager';
import { build } from './build';
import { HandshakeFailed, NoAnswer } from './httpRequest';
import { LocalBackend } from './LocalBackend';
import { Environment, recordSettings, unwritten } from './settings';

const recordOf = (workingDir: string) => path.join(workingDir, '.clay', 'backend.json');

function parsedChoice(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;

    throw error;
  }
}

function shapeOf(read: unknown): { type: string; settings: Record<string, unknown> } | undefined {
  if (!isRecord(read) || Object.keys(read).length !== 2) return undefined;

  const { type, settings } = read;
  return typeof type === 'string' && isRecord(settings) ? { type, settings } : undefined;
}

/** Built again from what `init` wrote, so it is checked as a block is. With no record, the state is where it is with no block. */
export function rememberedBackend(workingDir: string, env: Environment): StateBackend {
  const record = recordOf(workingDir);
  let content: string;

  try {
    content = fs.readFileSync(record, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new LocalBackend(workingDir);

    throw error;
  }

  const shape = shapeOf(parsedChoice(content));
  if (shape === undefined) throw unwritten(record);

  return build(recordSettings(shape.type, shape.settings, record), workingDir, env);
}

/** A journal alone counts where the state is a file, so what a stopped run recorded is not left unseen. */
async function leftBehind(before: StateBackend, workingDir: string): Promise<boolean> {
  if (before instanceof LocalBackend) return before.holdsAnything();

  try {
    return await before.exists();
  } catch (error) {
    if (error instanceof NoAnswer || error instanceof HandshakeFailed)
      throw new Error(`${error.message}. Whether a state is left there is not known; if that server is gone for good, remove ${recordOf(workingDir)} and run \`clay init\` again`, {
        cause: error,
      });

    throw error;
  }
}

const isSame = (a: BackendChoice, b: BackendChoice) => a.type === b.type && a.where === b.where;

function spelled(value: string | number | undefined): string {
  if (value === undefined) return 'unset';

  return typeof value === 'number' ? String(value) : `"${value}"`;
}

/** The first setting the configuration gives otherwise than `init` took it, for the same place. */
function changed(before: BackendChoice, now: BackendChoice): string | undefined {
  const name = [...Object.keys(now.settings), ...Object.keys(before.settings)].find((key) => now.settings[key] !== before.settings[key]);
  if (name === undefined) return undefined;

  return `${name} of backend "${now.type}" is ${spelled(now.settings[name])} in the configuration, and ${spelled(before.settings[name])} where \`clay init\` took it; run \`clay init\``;
}

/** Refuses a configuration that names another place than `init` last took, which would start from an empty state, or reaches it otherwise. */
export function checkBackend(backend: StateBackend, workingDir: string, env: Environment, position?: Position): void {
  const before = rememberedBackend(workingDir, env).choice;
  const now = backend.choice;
  const message = isSame(before, now)
    ? changed(before, now)
    : `This workspace keeps its state in "${before.where}" (${before.type}), and the configuration names "${now.where}" (${now.type}); run \`clay init\``;
  if (message === undefined) return;

  throw position ? new ConfigError(message, position) : new Error(message);
}

/** Asked before a state is moved; only true moves it. */
export type Approve = (question: string) => Promise<boolean>;

/** A state `init` found at the place it took before. */
export interface Moved {
  readonly from: BackendChoice;
  /** False where the new place held the same state already. */
  readonly copied: boolean;
}

export interface Adopted {
  /** Unset where the old place held no state. */
  readonly moved?: Moved;
  /** Set where the lock of the old place could not be released. */
  readonly lockLeft?: LockNotReleased;
}

function writeRecord(choice: BackendChoice, workingDir: string): void {
  const record = recordOf(workingDir);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  // Rename is atomic, so a stopped init leaves the old record whole.
  fs.writeFileSync(`${record}.tmp`, `${JSON.stringify({ type: choice.type, settings: choice.settings })}\n`, 'utf8');
  fs.renameSync(`${record}.tmp`, record);
}

/** What `init` took before, and the manager that locks it while the state moves. */
export interface Previous {
  readonly backend: StateBackend;
  readonly manager: StateManager;
}

/** Two places on one server may share a lock, which `init` holds already. */
const sharedLock = (a: BackendChoice, b: BackendChoice) =>
  a.type === b.type && a.settings.lock_address !== undefined && a.settings.lock_address === b.settings.lock_address && a.settings.lock_method === b.settings.lock_method;

const journalAlone = ({ where }: BackendChoice) =>
  new Error(`"${where}" has a journal and no state, so there is nothing to move; remove ${where}.journal and run \`clay init\` again`);

/** Called under both locks. `gone` is a state another run removed since `init` looked. */
async function copyState(before: StateBackend, backend: StateBackend, approve: Approve): Promise<'copied' | 'same' | 'gone'> {
  if (!(await before.exists())) {
    if (before instanceof LocalBackend) throw journalAlone(before.choice);
    return 'gone';
  }

  const from = before.choice;
  const to = backend.choice;
  const state = await before.read();
  if (await backend.exists()) {
    // The same state is what an init stopped after the copy leaves.
    if (isDeepStrictEqual(await backend.read(), state)) return 'same';

    throw new Error(`"${from.where}" and "${to.where}" both hold a state, and they differ; remove the one you do not want, and run \`clay init\` again`);
  }

  if (!(await approve(`Move the state in "${from.where}" (${from.type}) to "${to.where}" (${to.type})?`))) throw new Error('The state was not moved, and nothing changed');

  await backend.write(state);
  return 'copied';
}

/** The record is written before the old lock is released, so no run takes the old place in between. */
async function moveState(backend: StateBackend, previous: Previous, workingDir: string, approve: Approve): Promise<Adopted> {
  const { backend: before, manager: old } = previous;
  if (!sharedLock(before.choice, backend.choice)) await old.lock('init');

  let outcome: 'copied' | 'same' | 'gone';
  try {
    outcome = await copyState(before, backend, approve);
    writeRecord(backend.choice, workingDir);
  } catch (error) {
    return await old.unlockAfter(error);
  }

  const adopted = outcome === 'gone' ? {} : { moved: { from: before.choice, copied: outcome === 'copied' } };
  try {
    await old.unlock();
    return adopted;
  } catch (error) {
    if (!(error instanceof LockNotReleased)) throw error;

    return { ...adopted, lockLeft: error };
  }
}

/**
 * Takes what the configuration names, and moves the state from the place `previous` holds once `approve` says so. Called under the lock
 * of `backend`.
 */
export async function adoptBackend(backend: StateBackend, previous: Previous, workingDir: string, approve: Approve): Promise<Adopted> {
  const before = previous.backend;
  if (isDeepStrictEqual(before.choice, backend.choice)) return {};

  if (!isSame(before.choice, backend.choice) && (await leftBehind(before, workingDir))) return moveState(backend, previous, workingDir, approve);

  writeRecord(backend.choice, workingDir);
  return {};
}

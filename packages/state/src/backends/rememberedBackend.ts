import { isRecord } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';
import * as fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BackendChoice, StateBackend } from '../StateBackend';
import { build } from './build';
import { replaceSynced } from './durable';
import { HandshakeFailed, NoAnswer } from './httpRequest';
import { LocalBackend } from './LocalBackend';
import { Adopted, Approve, moveStates, namedWorkspaces, Previous, Stoppable, unstoppable } from './moveState';
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

function spelled(value: string | number | boolean | undefined): string {
  if (value === undefined) return 'unset';

  return typeof value === 'string' ? `"${value}"` : String(value);
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
    : `This directory keeps its state in "${before.where}" (${before.type}), and the configuration names "${now.where}" (${now.type}); run \`clay init\``;
  if (message === undefined) return;

  throw position ? new ConfigError(message, position) : new Error(message);
}

async function writeRecord(choice: BackendChoice, workingDir: string): Promise<void> {
  // A record lost to a power loss would turn the next run to an empty local state.
  await replaceSynced(recordOf(workingDir), `${JSON.stringify({ type: choice.type, settings: choice.settings })}\n`);
}

/**
 * Takes what the configuration names, and moves the state of every workspace from the place `previous` holds once `approve` says so.
 * Called under the lock of `backend`; the other locks are taken through `stoppable`.
 */
export async function adoptBackend(backend: StateBackend, previous: Previous, workingDir: string, approve: Approve, stoppable: Stoppable = unstoppable): Promise<Adopted> {
  const before = previous.backend;
  if (isDeepStrictEqual(before.choice, backend.choice)) return {};

  if (!isSame(before.choice, backend.choice)) {
    const named = await namedWorkspaces(before, backend);
    if (named.length > 0 || (await leftBehind(before, workingDir))) return moveStates(named, backend, previous, approve, stoppable, () => writeRecord(backend.choice, workingDir));
  }

  await writeRecord(backend.choice, workingDir);
  return {};
}

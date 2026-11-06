import { isRecord } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';
import * as fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BackendChoice, StateBackend } from '../StateBackend';
import { build } from './build';
import { NoAnswer } from './HttpBackend';
import { LocalBackend } from './LocalBackend';
import { recordSettings, unwritten } from './settings';

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
function remembered(workingDir: string): StateBackend {
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

  return build(recordSettings(shape.type, shape.settings, record), workingDir);
}

/** A journal counts where the state is a file: a state moved without it would lose what a stopped run recorded. */
async function leftBehind(before: StateBackend, workingDir: string): Promise<boolean> {
  if (before instanceof LocalBackend) return before.holdsAnything();

  try {
    return await before.exists();
  } catch (error) {
    if (error instanceof NoAnswer)
      throw new Error(
        `${error.message}, so whether a state is left there is not known. If that server is gone for good, remove ${recordOf(workingDir)} and run \`clay init\` again`,
        { cause: error }
      );

    throw error;
  }
}

const isSame = (a: BackendChoice, b: BackendChoice) => a.type === b.type && a.where === b.where;

/** The first setting the configuration gives otherwise than `init` took it, for the same place. */
function changed(before: BackendChoice, now: BackendChoice): string | undefined {
  const name = [...Object.keys(now.settings), ...Object.keys(before.settings)].find((key) => now.settings[key] !== before.settings[key]);
  if (name === undefined) return undefined;

  return `${name} of backend "${now.type}" is "${now.settings[name]}" in the configuration, and "${before.settings[name]}" where \`clay init\` took it; run \`clay init\``;
}

/** Refuses a configuration that names another place than `init` last took, which would start from an empty state, or reaches it otherwise. */
export function checkBackend(backend: StateBackend, workingDir: string, position?: Position): void {
  const before = remembered(workingDir).choice;
  const now = backend.choice;
  const message = isSame(before, now)
    ? changed(before, now)
    : `This workspace keeps its state in "${before.where}" (${before.type}), and the configuration names "${now.where}" (${now.type}); run \`clay init\``;
  if (message === undefined) return;

  throw position ? new ConfigError(message, position) : new Error(message);
}

/** Takes what the configuration names, once no state is left behind at an old place. */
export async function adoptBackend(backend: StateBackend, workingDir: string): Promise<void> {
  await backend.check();

  const before = remembered(workingDir);
  const { where, type } = before.choice;
  if (isDeepStrictEqual(before.choice, backend.choice)) return;

  if (!isSame(before.choice, backend.choice) && (await leftBehind(before, workingDir)))
    throw new Error(
      `The state in "${where}" would be left behind, as the configuration names "${backend.choice.where}"; move it there by hand${type === 'local' ? ' with any .journal beside it, or remove them' : ', or remove it'}, and run \`clay init\` again`
    );

  const { type: kept, settings } = backend.choice;
  const record = recordOf(workingDir);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  // Rename is atomic, so a stopped init leaves the old record whole.
  fs.writeFileSync(`${record}.tmp`, `${JSON.stringify({ type: kept, settings })}\n`, 'utf8');
  fs.renameSync(`${record}.tmp`, record);
}

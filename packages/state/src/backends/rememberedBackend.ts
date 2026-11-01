import { ConfigError, Position } from '@clay/parser';
import * as fs from 'node:fs';
import path from 'node:path';

import { BackendChoice, StateBackend } from '../StateBackend';
import { LocalBackend } from './LocalBackend';

const recordOf = (workingDir: string) => path.join(workingDir, '.clay', 'backend.json');

function parsedChoice(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;

    throw error;
  }
}

function isChoice(value: unknown): value is BackendChoice {
  const { type, where } = (value ?? {}) as Partial<BackendChoice>;

  return type === 'local' && typeof where === 'string';
}

/** With no record, the state is where it is with no block. */
function remembered(workingDir: string): BackendChoice {
  const record = recordOf(workingDir);
  let content: string;

  try {
    content = fs.readFileSync(record, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new LocalBackend(workingDir).choice;

    throw error;
  }

  const choice = parsedChoice(content);
  if (!isChoice(choice)) throw new Error(`${record} is not what \`clay init\` writes; remove it and run \`clay init\``);

  return choice;
}

const isSame = (a: BackendChoice, b: BackendChoice) => a.type === b.type && a.where === b.where;

/** Refuses a configuration that names another place than `init` last took, which would start from an empty state. */
export function checkBackend(backend: StateBackend, workingDir: string, position?: Position): void {
  const before = remembered(workingDir);
  if (isSame(before, backend.choice)) return;

  const message = `This workspace keeps its state in "${before.where}" (${before.type}), and the configuration names "${backend.choice.where}" (${backend.choice.type}); run \`clay init\``;
  throw position ? new ConfigError(message, position) : new Error(message);
}

/** Takes the place the configuration names, once no state is left behind at the old one. */
export async function adoptBackend(backend: StateBackend, workingDir: string): Promise<void> {
  await backend.check();

  const before = remembered(workingDir);
  if (isSame(before, backend.choice)) return;

  if (await new LocalBackend(workingDir, before.where).holdsAnything())
    throw new Error(
      `The state in "${before.where}" would be left behind, as the configuration names "${backend.choice.where}"; move it there by hand with any .journal beside it, or remove them, and run \`clay init\` again`
    );

  const record = recordOf(workingDir);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  // Rename is atomic, so a stopped init leaves the old record whole.
  fs.writeFileSync(`${record}.tmp`, `${JSON.stringify(backend.choice)}\n`, 'utf8');
  fs.renameSync(`${record}.tmp`, record);
}

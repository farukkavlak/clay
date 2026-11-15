import * as fs from 'node:fs';
import path from 'node:path';

import { replaceSynced } from './durable';
import { DEFAULT_WORKSPACE, NamedWorkspace, StateBackend } from '../StateBackend';

// A DNS label, since the name goes into paths and resource names; lowercase, as a macOS disk does not tell cases apart.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isWorkspaceName = (name: string) => NAME.test(name);

/** Refuses a name that is not a DNS label, naming where it came from, before any path is made of it. */
export function checkWorkspaceName(name: string, source: string): string {
  if (isWorkspaceName(name)) return name;

  throw new Error(
    `Workspace name ${JSON.stringify(name)} in ${source} is not valid: use lowercase letters, digits and "-", 1 to 63 characters, starting and ending with a letter or digit`
  );
}

const selectionOf = (workingDir: string) => path.join(workingDir, '.clay', 'workspace');

/** The workspace `.clay/workspace` selects, and the default one where there is no such file. */
export function selectedWorkspace(workingDir: string): string {
  const file = selectionOf(workingDir);
  let content: string;

  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_WORKSPACE;

    throw error;
  }

  // An editor ends the file with a line break.
  return checkWorkspaceName(content.replace(/\r?\n$/, ''), file);
}

/** Selects workspace `name` for the commands that follow, with the name checked already. */
export async function selectWorkspace(workingDir: string, name: string): Promise<void> {
  await replaceSynced(selectionOf(workingDir), `${name}\n`);
}

/** The backend of named workspace `name`, whether its state exists or not. */
export function namedWorkspace(backend: StateBackend, name: string): NamedWorkspace {
  if (backend.workspace === undefined) throw new Error(`Backend "${backend.choice.type}" keeps one state, so workspace "${name}" cannot be used`);

  return backend.workspace(name);
}

/** The backend of workspace `name`. A named one must exist, so a selection that names a missing one never starts from an empty state. */
export async function workspaceBackend(backend: StateBackend, name: string): Promise<StateBackend> {
  if (name === DEFAULT_WORKSPACE) return backend;

  const named = namedWorkspace(backend, name);
  if (!(await named.exists())) throw new Error(`Workspace "${name}" does not exist; run \`clay workspace new ${name}\` to make it`);

  return named;
}

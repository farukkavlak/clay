import { isWorkspaceName } from '@clay/contracts';
import * as fs from 'node:fs';
import path from 'node:path';

import { replaceSynced } from './durable';
import { Environment, variable } from './settings';
import { DEFAULT_WORKSPACE, NamedWorkspace, StateBackend } from '../StateBackend';

/** Refuses a name that is not a DNS label, naming where it came from, before any path is made of it. */
export function checkWorkspaceName(name: string, source: string): string {
  if (isWorkspaceName(name)) return name;

  throw new Error(
    `Workspace name ${JSON.stringify(name)} in ${source} is not valid: use lowercase letters, digits and "-", 1 to 63 characters, starting and ending with a letter or digit`
  );
}

const WORKSPACE_VARIABLE = 'CLAY_WORKSPACE';

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

/** The workspace `CLAY_WORKSPACE` names for this one command, if it names one. */
export function givenWorkspace(env: Environment): string | undefined {
  const name = variable(env, WORKSPACE_VARIABLE);

  return name === undefined ? undefined : checkWorkspaceName(name, WORKSPACE_VARIABLE);
}

/** The workspace a command runs on. `.clay/workspace` is not read where `CLAY_WORKSPACE` names one. */
export function currentWorkspace(workingDir: string, env: Environment): string {
  return givenWorkspace(env) ?? selectedWorkspace(workingDir);
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

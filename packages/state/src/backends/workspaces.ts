import { isWorkspaceName } from '@clay/contracts';
import * as fs from 'node:fs';
import path from 'node:path';

import { replaceSynced } from './durable';
import { Environment, Settings, variable } from './settings';
import { DEFAULT_WORKSPACE, NamedWorkspace, StateBackend, WORKSPACES_FOLDER } from '../StateBackend';

/** Refuses a name that is not a DNS label, naming where it came from, before any path is made of it. */
export function checkWorkspaceName(name: string, source: string): string {
  if (isWorkspaceName(name)) return name;

  throw new Error(
    `Workspace name ${JSON.stringify(name)} in ${source} is not valid: use lowercase letters, digits and "-", 1 to 63 characters, starting and ending with a letter or digit`
  );
}

/** What a backend that keeps only a lock beside each state must not name as a state. */
export const LOCK_BESIDE = ['.lock'];

/** Refuses a place that is what another state keeps beside it. Case is ignored, as a macOS disk ignores it. */
export function checkNotBeside(settings: Settings, name: string, written: string, parts: readonly string[], beside: readonly string[]): void {
  const file = parts.at(-1)?.toLowerCase();
  const suffix = beside.find((ending) => file?.endsWith(ending));
  if (suffix !== undefined) settings.refuse(`${name} of backend "${settings.type}" is "${written}", and a name ending in ${suffix} is what Clay keeps beside a state`, name);
}

/** The workspace whose state a place would be, for the state next to its folder of workspaces. */
export function workspaceAt(parts: readonly string[]): string | undefined {
  const [folder, workspace] = parts.slice(-3, -1).map((part) => part.toLowerCase());
  return folder === WORKSPACES_FOLDER && isWorkspaceName(workspace) ? workspace : undefined;
}

/** Refuses the state of another configuration's workspace, which this one would share without a word. */
export function checkNotWorkspaceState(settings: Settings, name: string, written: string, parts: readonly string[]): void {
  const workspace = workspaceAt(parts);
  if (workspace !== undefined) settings.refuse(`${name} of backend "${settings.type}" is "${written}", which is where Clay keeps the state of workspace "${workspace}"`, name);
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

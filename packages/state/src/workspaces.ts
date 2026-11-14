import * as fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_WORKSPACE, StateBackend } from './StateBackend';

// A DNS label, since the name goes into paths and resource names; lowercase, as a macOS disk does not tell cases apart.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Refuses a name that is not a DNS label, naming where it came from, before any path is made of it. */
export function checkWorkspaceName(name: string, source: string): string {
  if (NAME.test(name)) return name;

  throw new Error(
    `Workspace name ${JSON.stringify(name)} in ${source} is not valid: use lowercase letters, digits and "-", 1 to 63 characters, starting and ending with a letter or digit`
  );
}

/** The workspace `.clay/workspace` selects, and the default one where there is no such file. */
export function selectedWorkspace(workingDir: string): string {
  const file = path.join(workingDir, '.clay', 'workspace');
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

/** The backend of workspace `name`. A named one must exist, so a selection that names a missing one never starts from an empty state. */
export async function workspaceBackend(backend: StateBackend, name: string): Promise<StateBackend> {
  if (name === DEFAULT_WORKSPACE) return backend;
  if (backend.workspace === undefined) throw new Error(`Backend "${backend.choice.type}" keeps one state, so workspace "${name}" cannot be used`);

  const named = backend.workspace(name);
  if (!(await named.exists())) throw new Error(`Workspace "${name}" does not exist`);

  return named;
}

import { ConfigFiles, rootBackend } from '@clay/orchestrator';
import { backendFrom, checkBackend, DEFAULT_WORKSPACE, selectedWorkspace, StateBackend, workspaceBackend } from '@clay/state';

/** The backend the root configuration names, not held to what `init` took: for `validate`, and for `init` itself. */
export function namedBackend(cwd: string, files: ConfigFiles): StateBackend {
  return backendFrom(rootBackend(files), cwd, process.env);
}

/** The backend of the default workspace, which `init` must have taken. */
export function checkedBackend(cwd: string, files: ConfigFiles): StateBackend {
  const block = rootBackend(files);
  const backend = backendFrom(block, cwd, process.env);
  checkBackend(backend, cwd, process.env, block?.backendType.position);

  return backend;
}

export interface SelectedState {
  workspace: string;
  backend: StateBackend;
}

/** The selected workspace and its backend, which `init` must have taken. */
export async function selectedState(cwd: string, files: ConfigFiles): Promise<SelectedState> {
  const workspace = selectedWorkspace(cwd);
  return { workspace, backend: await workspaceBackend(checkedBackend(cwd, files), workspace) };
}

/** The backend of the selected workspace, which `init` must have taken. */
export async function stateFile(cwd: string, files: ConfigFiles): Promise<StateBackend> {
  const { backend } = await selectedState(cwd, files);
  return backend;
}

/** Nothing on the default workspace, so a directory that uses none reads as it did. */
export function inWorkspace(workspace: string): string {
  return workspace === DEFAULT_WORKSPACE ? '' : ` in workspace "${workspace}"`;
}

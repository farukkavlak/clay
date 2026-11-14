import { ConfigFiles, rootBackend } from '@clay/orchestrator';
import { backendFrom, checkBackend, selectedWorkspace, StateBackend, workspaceBackend } from '@clay/state';

/** The backend the root configuration names, not held to what `init` took: for `validate`, and for `init` itself. */
export function namedBackend(cwd: string, files: ConfigFiles): StateBackend {
  return backendFrom(rootBackend(files), cwd, process.env);
}

/** The backend of the selected workspace, which `init` must have taken. */
export async function stateFile(cwd: string, files: ConfigFiles): Promise<StateBackend> {
  const block = rootBackend(files);
  const backend = backendFrom(block, cwd, process.env);
  checkBackend(backend, cwd, process.env, block?.backendType.position);

  return workspaceBackend(backend, selectedWorkspace(cwd));
}

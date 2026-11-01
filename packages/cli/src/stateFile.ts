import { ConfigFiles, rootBackend } from '@clay/orchestrator';
import { backendFrom, checkBackend, StateBackend } from '@clay/state';

/** The backend the root configuration names, not held to what `init` took: for `validate`, and for `init` itself. */
export function namedBackend(cwd: string, files: ConfigFiles): StateBackend {
  return backendFrom(rootBackend(files), cwd);
}

/** The backend to run on, which `init` must have taken. */
export function stateFile(cwd: string, files: ConfigFiles): StateBackend {
  const block = rootBackend(files);
  const backend = backendFrom(block, cwd);
  checkBackend(backend, cwd, block?.backendType.position);

  return backend;
}

import { ConfigFiles, rootBackend } from '@clay/orchestrator';
import { backendFrom, checkBackend, StateBackend } from '@clay/state';

/** The backend the root configuration names, not held to what `init` took: for `validate`, and for `init` itself. */
export function namedBackend(cwd: string, files: ConfigFiles): StateBackend {
  return backendFrom(rootBackend(files), cwd, process.env);
}

/** The backend to run on, which `init` must have taken. */
export function stateFile(cwd: string, files: ConfigFiles): StateBackend {
  const block = rootBackend(files);
  const backend = backendFrom(block, cwd, process.env);
  checkBackend(backend, cwd, process.env, block?.backendType.position);

  return backend;
}

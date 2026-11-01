import { ConfigFiles, rootBackend } from '@clay/orchestrator';
import { backendFrom, StateBackend } from '@clay/state';

/** The backend the root configuration names. */
export function stateFile(cwd: string, files: ConfigFiles): StateBackend {
  return backendFrom(rootBackend(files), cwd);
}

import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { StateBackend, StateManager } from '@clay/state';

import { stateFile } from './stateFile';

export function newOrchestrator(cwd: string, files: ConfigFiles, backend: StateBackend = stateFile(cwd, files)): Orchestrator {
  const orchestrator = Orchestrator.create(new StateManager(backend), files);
  orchestrator.registerProvider(new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

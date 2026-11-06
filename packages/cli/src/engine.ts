import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { StateManager } from '@clay/state';

import { stateFile } from './stateFile';

/** `manager` is passed in where the command must reach the lock it holds. */
export function newOrchestrator(cwd: string, files: ConfigFiles, manager: StateManager = new StateManager(stateFile(cwd, files))): Orchestrator {
  const orchestrator = Orchestrator.create(manager, files);
  orchestrator.registerProvider(new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { StateManager } from '@clay/state';

import { stateFile } from './stateFile';

export function newOrchestrator(cwd: string, files: ConfigFiles): Orchestrator {
  const orchestrator = Orchestrator.create(new StateManager(stateFile(cwd, files)), files);
  orchestrator.registerProvider(new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

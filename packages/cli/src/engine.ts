import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { StateManager } from '@clay/state';

export function newOrchestrator(files: ConfigFiles, manager: StateManager): Orchestrator {
  const orchestrator = Orchestrator.create(manager, files);
  orchestrator.registerProvider(new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

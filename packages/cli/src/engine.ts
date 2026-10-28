import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';

export function newOrchestrator(cwd: string, files: ConfigFiles): Orchestrator {
  const orchestrator = Orchestrator.create(new StateManager(new LocalBackend(cwd)), files);
  orchestrator.registerProvider(new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

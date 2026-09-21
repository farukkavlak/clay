import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';

/** The engine every command runs, with the state in `cwd` and the one provider there is. */
export function newOrchestrator(cwd: string, files: ConfigFiles): Orchestrator {
  const orchestrator = Orchestrator.create(new StateManager(new LocalBackend(cwd)), files);
  orchestrator.registerProvider(new LocalProvider());

  return orchestrator;
}

import { ConfigFiles, Orchestrator } from '@clay/orchestrator';
import { LocalExecProvisioner, LocalProvider } from '@clay/provider-local';
import { StateManager } from '@clay/state';

/** `workspace` is what `clay.workspace` reads; a check, which holds for every workspace, is given none. */
export function newOrchestrator(files: ConfigFiles, manager: StateManager, workspace: string | undefined): Orchestrator {
  const orchestrator = Orchestrator.create(manager, files, workspace);
  orchestrator.registerProvider(() => new LocalProvider());
  orchestrator.registerProvisioner(new LocalExecProvisioner());

  return orchestrator;
}

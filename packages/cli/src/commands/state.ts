import { Address, State } from '@clay/contracts';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { exists, stateFile } from '../stateFile';

function getStateManager(backend = stateFile()): StateManager {
  return new StateManager(backend);
}

async function reportEmpty(path: string): Promise<void> {
  const found = await exists(path);

  console.log(styleText('yellow', found ? `No resources in ${path}` : `No state file found at ${path}`));
}

/** A resource's address lives in its key, in its entry and in every entry that reads from it. */
function moveResource(state: State, source: string, destination: string): void {
  const from = Address.parse(source);
  const to = Address.parse(destination);
  if (from.resourceType !== to.resourceType) throw new Error(`Cannot move ${source} to ${destination}: the type changes`);

  state.resources[destination] = { ...state.resources[source], name: to.name, modulePath: to.modulePath };
  delete state.resources[source];

  for (const resource of Object.values(state.resources))
    if (resource.dependencies) resource.dependencies = resource.dependencies.map((dependency) => (dependency === source ? destination : dependency));
}

export function createStateCommand(): Command {
  const command = new Command('state').description('Advanced state management');

  command
    .command('list')
    .description('List resources in the state')
    .action(async () => {
      try {
        const backend = stateFile();
        const state = await getStateManager(backend).read();

        if (Object.keys(state.resources).length === 0) {
          await reportEmpty(backend.path);
          return;
        }

        for (const key of Object.keys(state.resources).sort()) console.log(key);
      } catch (error) {
        console.error(styleText('red', 'Error listing state:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('show')
    .description('Show a resource in the state')
    .argument('<address>', 'Resource address')
    .action(async (address) => {
      try {
        const manager = getStateManager();
        const state = await manager.read();
        const resource = state.resources[address];

        if (!resource) {
          console.error(styleText('red', `Resource not found: ${address}`));
          process.exit(1);
        }

        console.log(styleText('bold', `# ${address}:`));
        console.log(`resource "${resource.resourceType}" "${resource.name}" {`);
        for (const [key, value] of Object.entries(resource.attributes || {})) console.log(`  ${key} = ${JSON.stringify(value)}`);

        console.log('}');
      } catch (error) {
        console.error(styleText('red', 'Error showing resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('mv')
    .description('Move an item in the state')
    .argument('<source>', 'Source address')
    .argument('<destination>', 'Destination address')
    .action(async (source, destination) => {
      try {
        const manager = getStateManager();
        await manager.lock();
        try {
          const state = await manager.read();

          if (!state.resources[source]) throw new Error(`Source resource not found: ${source}`);

          if (state.resources[destination]) throw new Error(`Destination resource already exists: ${destination}`);

          console.log(styleText('yellow', `Moving ${source} to ${destination}...`));

          moveResource(state, source, destination);
          // Outputs come from a finished run; the next one writes them again.
          delete state.outputs;

          await manager.write(state);
          console.log(styleText('green', 'Successfully moved resource.'));
        } finally {
          await manager.unlock();
        }
      } catch (error) {
        console.error(styleText('red', 'Error moving resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('rm')
    .description('Remove instances from the state')
    .argument('<address>', 'Resource address')
    .action(async (address) => {
      try {
        const manager = getStateManager();
        await manager.lock();
        try {
          const state = await manager.read();

          if (!state.resources[address]) {
            console.log(styleText('yellow', `Resource not found in state: ${address}`));
            return;
          }

          console.log(styleText('yellow', `Removing ${address}...`));
          delete state.resources[address];
          delete state.outputs;

          await manager.write(state);
          console.log(styleText('green', 'Successfully removed resource.'));
        } finally {
          await manager.unlock();
        }
      } catch (error) {
        console.error(styleText('red', 'Error removing resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

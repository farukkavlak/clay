import { Address, Resource, State } from '@clay/contracts';
import { mapDependencies, moveResource, StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { exists } from '../exists';
import { stateFile } from '../stateFile';

function getStateManager(backend = stateFile()): StateManager {
  return new StateManager(backend);
}

async function reportEmpty(path: string): Promise<void> {
  const found = await exists(path);

  console.log(styleText('yellow', found ? `No resources in ${path}` : `No state file found at ${path}`));
}

/** Own keys only, so `toString` is not a resource. */
function findResource(state: State, address: string): Resource | undefined {
  const key = Address.parse(address).toString();

  return Object.hasOwn(state.resources, key) ? state.resources[key] : undefined;
}

/** A move may not change the type, which decides the provider. */
function checkedMove(state: State, source: string, destination: string): void {
  const from = Address.parse(source);
  const to = Address.parse(destination);
  if (from.resourceType !== to.resourceType) throw new Error(`Cannot move ${source} to ${destination}: the type changes`);

  moveResource(state, from, to);
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
        const resource = findResource(state, address);

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

          if (!findResource(state, source)) throw new Error(`Source resource not found: ${source}`);

          if (findResource(state, destination)) throw new Error(`Destination resource already exists: ${destination}`);

          console.log(styleText('yellow', `Moving ${source} to ${destination}...`));

          checkedMove(state, source, destination);
          // Outputs belong to a finished run; the next one writes them again.
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
          const key = Address.parse(address).toString();

          if (!Object.hasOwn(state.resources, key)) {
            console.log(styleText('yellow', `Resource not found in state: ${address}`));
            return;
          }

          console.log(styleText('yellow', `Removing ${key}...`));
          delete state.resources[key];
          mapDependencies(state, (dependency) => (dependency === key ? undefined : dependency));
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

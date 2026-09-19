import { StateManager } from '@clay/state';
import chalk from 'chalk';
import { Command } from 'commander';

import { stateBackend } from '../stateFile';

function getStateManager(statePath?: string): StateManager {
  return new StateManager(stateBackend(statePath));
}

export function createStateCommand(): Command {
  const command = new Command('state').description('Advanced state management');

  command
    .command('list')
    .description('List resources in the state')
    .option('--state <path>', 'Path to state file')
    .action(async (options) => {
      try {
        const manager = getStateManager(options.state);
        const state = await manager.read();

        if (!state.resources || Object.keys(state.resources).length === 0) {
          console.log('The state file is empty.');
          return;
        }

        for (const key of Object.keys(state.resources).sort()) console.log(key);
      } catch (error) {
        console.error(chalk.red('Error listing state:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('show')
    .description('Show a resource in the state')
    .argument('<address>', 'Resource address')
    .option('--state <path>', 'Path to state file')
    .action(async (address, options) => {
      try {
        const manager = getStateManager(options.state);
        const state = await manager.read();
        const resource = state.resources[address];

        if (!resource) {
          console.error(chalk.red(`Resource not found: ${address}`));
          process.exit(1);
        }

        console.log(chalk.bold(`# ${address}:`));
        console.log(`resource "${resource.type}" "${resource.name}" {`);
        for (const [key, value] of Object.entries(resource.attributes || {})) console.log(`  ${key} = ${JSON.stringify(value)}`);

        console.log('}');
      } catch (error) {
        console.error(chalk.red('Error showing resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('mv')
    .description('Move an item in the state')
    .argument('<source>', 'Source address')
    .argument('<destination>', 'Destination address')
    .option('--state <path>', 'Path to state file')
    .action(async (source, destination, options) => {
      try {
        const manager = getStateManager(options.state);
        // Lock state before modification
        await manager.lock();
        try {
          const state = await manager.read();

          if (!state.resources[source]) throw new Error(`Source resource not found: ${source}`);

          if (state.resources[destination]) throw new Error(`Destination resource already exists: ${destination}`);

          console.log(chalk.yellow(`Moving ${source} to ${destination}...`));

          // Move resource
          state.resources[destination] = {
            ...state.resources[source],
          };
          delete state.resources[source];

          await manager.write(state);
          console.log(chalk.green('Successfully moved resource.'));
        } finally {
          await manager.unlock();
        }
      } catch (error) {
        console.error(chalk.red('Error moving resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  command
    .command('rm')
    .description('Remove instances from the state')
    .argument('<address>', 'Resource address')
    .option('--state <path>', 'Path to state file')
    .action(async (address, options) => {
      try {
        const manager = getStateManager(options.state);
        await manager.lock();
        try {
          const state = await manager.read();

          if (!state.resources[address]) {
            console.log(chalk.yellow(`Resource not found in state: ${address}`));
            return;
          }

          console.log(chalk.yellow(`Removing ${address}...`));
          delete state.resources[address];

          await manager.write(state);
          console.log(chalk.green('Successfully removed resource.'));
        } finally {
          await manager.unlock();
        }
      } catch (error) {
        console.error(chalk.red('Error removing resource:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

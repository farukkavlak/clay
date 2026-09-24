import { StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { exists } from '../exists';
import { stateFile } from '../stateFile';

function displayOutputs(outputs: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outputs, null, 2));
    return;
  }

  if (Object.keys(outputs).length === 0) console.log(styleText('yellow', 'No outputs found in state.'));
  else {
    console.log(styleText('bold', '\nOutputs:\n'));
    for (const [key, value] of Object.entries(outputs)) console.log(`${styleText('cyan', key)} = ${styleText('green', JSON.stringify(value))}`);

    console.log();
  }
}

export function createOutputCommand(): Command {
  const command = new Command('output');

  command
    .description('Show output values from the current state')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      const backend = stateFile();

      try {
        if (!(await exists(backend.path))) {
          console.log(styleText('yellow', `No state file found at ${backend.path}`));
          return;
        }

        const state = await new StateManager(backend).read();

        displayOutputs(state.outputs ?? {}, options.json);
      } catch (error) {
        console.error(styleText('red', 'Error reading outputs:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  return command;
}

import { jsonText, Output, SENSITIVE } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { printable } from '../printable';
import { stateFile } from '../stateFile';

/** JSON includes each type, so a script can tell a set from a list. */
function displayOutputs(outputs: Record<string, Output>, json: boolean): void {
  if (json) {
    console.log(jsonText(outputs, 2));
    return;
  }

  if (Object.keys(outputs).length === 0) console.log(styleText('yellow', 'No outputs found in state.'));
  else {
    console.log(styleText('bold', '\nOutputs:\n'));
    for (const [key, { value, sensitive }] of Object.entries(outputs)) console.log(`${styleText('cyan', key)} = ${styleText('green', sensitive ? SENSITIVE : jsonText(value))}`);

    console.log();
  }
}

export function createOutputCommand(): Command {
  const command = new Command('output');

  command
    .description('Show output values from the current state')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      try {
        const backend = stateFile(cwd, files);
        if (!(await backend.exists())) {
          if (options.json) displayOutputs({}, true);
          else console.log(styleText('yellow', `No state file found at ${printable(backend.location)}`));
          return;
        }

        const state = await new StateManager(backend).read();

        displayOutputs(state.outputs ?? {}, options.json);
      } catch (error) {
        console.error(styleText('red', 'Error reading outputs:'), describeError(error, files));
        process.exit(1);
      }
    });

  return command;
}

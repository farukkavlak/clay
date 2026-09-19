import { StateManager } from '@miniform/state';
import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'node:fs/promises';

import { stateBackend } from '../stateFile';

function extractScopeOutputs(scope: string, vars: unknown, outputs: Record<string, unknown>): void {
  // Root scope outputs don't have module prefix
  if ((scope === '' || !scope.includes('module.')) && typeof vars === 'object' && vars !== null)
    for (const [key, varValue] of Object.entries(vars))
      // Skip internal variables, only show outputs
      outputs[key] = typeof varValue === 'object' && varValue !== null && 'value' in varValue ? (varValue as { value: unknown }).value : varValue;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractOutputs(variables: Record<string, any> | undefined): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  if (!variables) return outputs;

  for (const [scope, vars] of Object.entries(variables)) extractScopeOutputs(scope, vars, outputs);

  return outputs;
}

function displayOutputs(outputs: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outputs, null, 2));
    return;
  }

  if (Object.keys(outputs).length === 0) console.log(chalk.yellow('No outputs found in state.'));
  else {
    console.log(chalk.bold('\nOutputs:\n'));
    for (const [key, value] of Object.entries(outputs)) console.log(`${chalk.cyan(key)} = ${chalk.green(JSON.stringify(value))}`);

    console.log();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function createOutputCommand(): Command {
  const command = new Command('output');

  command
    .description('Show output values from the current state')
    .option('--json', 'Output in JSON format')
    .option('--state <path>', 'Path to state file')
    .action(async (options) => {
      const backend = stateBackend(options.state);

      if (!(await exists(backend.path))) {
        console.log(chalk.yellow(`No state file found at ${backend.path}`));
        return;
      }

      try {
        const state = await new StateManager(backend).read();

        // Extract outputs from state
        const outputs = extractOutputs(state.variables);

        // Display outputs
        displayOutputs(outputs, options.json);
      } catch (error) {
        console.error(chalk.red('Error reading outputs:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  return command;
}

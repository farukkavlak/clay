import { Orchestrator } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { isUnknown, PlanAction, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';

function getActionSymbol(actionType: string): string {
  if (actionType === 'CREATE') return chalk.green('+');
  if (actionType === 'UPDATE') return chalk.yellow('~');
  if (actionType === 'REPLACE') return chalk.red('-') + chalk.green('+');
  if (actionType === 'DELETE') return chalk.red('-');
  return ' ';
}

function getActionTypeColor(actionType: string): string {
  if (actionType === 'CREATE') return chalk.green('create');
  if (actionType === 'UPDATE') return chalk.yellow('update');
  if (actionType === 'REPLACE') return chalk.red('replace');
  if (actionType === 'DELETE') return chalk.red('destroy');
  return 'no-op';
}

function describeValue(value: unknown, whenAbsent: string): string {
  if (value === undefined) return whenAbsent;
  return isUnknown(value) ? '(known after apply)' : JSON.stringify(value);
}

function displayAction(action: PlanAction): void {
  const symbol = getActionSymbol(action.type);
  const typeColor = getActionTypeColor(action.type);
  console.log(`  ${symbol} ${action.resourceType}.${action.name} will be ${typeColor}d`);

  if ((action.type === 'UPDATE' || action.type === 'REPLACE') && action.changes)
    for (const [key, change] of Object.entries(action.changes)) console.log(`      ${key}: ${describeValue(change.old, '(none)')} -> ${describeValue(change.new, '(removed)')}`);
}

function displayPlanSummary(actions: PlanAction[]): void {
  // A replacement counts once as an add and once as a destroy.
  const replaceCount = actions.filter((a) => a.type === 'REPLACE').length;
  const createCount = actions.filter((a) => a.type === 'CREATE').length + replaceCount;
  const updateCount = actions.filter((a) => a.type === 'UPDATE').length;
  const deleteCount = actions.filter((a) => a.type === 'DELETE').length + replaceCount;

  console.log(chalk.bold(`\nPlan: ${createCount} to add, ${updateCount} to change, ${deleteCount} to destroy.`));
}

async function executePlan(cwd: string, configPath: string, outFile?: string): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');

  const backend = new LocalBackend(cwd);
  const stateManager = new StateManager(backend);
  const orchestrator = new Orchestrator(stateManager);
  orchestrator.registerProvider(new LocalProvider());

  console.log(chalk.blue('Refreshing state...'));

  const actions = await orchestrator.plan(configContent);
  const changes = actions.filter((action) => action.type !== 'NO_OP');

  if (changes.length === 0) console.log(chalk.green('No changes. Your infrastructure matches the configuration.'));
  else {
    console.log(chalk.bold('\nClay will perform the following actions:\n'));
    for (const action of changes) displayAction(action);
    displayPlanSummary(actions);
  }

  if (outFile) {
    const planFile = serializePlan(actions, configContent);
    await fs.writeFile(outFile, JSON.stringify(planFile, null, 2), 'utf8');
    console.log(chalk.green(`\nPlan saved to: ${outFile}`));
  }
}

export function createPlanCommand() {
  return new Command('plan')
    .description('Show changes required by the current configuration')
    .option('--out <file>', 'Save plan to file')
    .action(async (options) => {
      const cwd = process.cwd();
      const configPath = path.join(cwd, CONFIG_FILE);

      try {
        await fs.access(configPath);
      } catch {
        console.error(chalk.red(`Error: ${CONFIG_FILE} not found in current directory.`));
        process.exit(1);
      }

      try {
        await executePlan(cwd, configPath, options.out);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('Planning failed:'), message);
        process.exit(1);
      }
    });
}

import { Orchestrator } from '@miniform/orchestrator';
import { PlanAction, PlanFile, validatePlanFile } from '@miniform/planner';
import { LocalProvider } from '@miniform/provider-local';
import { LocalBackend, StateManager } from '@miniform/state';
import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function getActionSymbol(actionType: string): string {
  if (actionType === 'CREATE') return chalk.green('+');
  if (actionType === 'UPDATE') return chalk.yellow('~');
  if (actionType === 'REPLACE') return chalk.red('-') + chalk.green('+');
  if (actionType === 'DELETE') return chalk.red('-');
  return ' ';
}

function displayActions(actions: PlanAction[]): void {
  console.log(chalk.bold('\nMiniform will perform the following actions:\n'));
  for (const action of actions) {
    if (action.type === 'NO_OP') continue;
    const symbol = getActionSymbol(action.type);
    console.log(`  ${symbol} ${action.resourceType}.${action.name}`);
  }
}

async function confirmApply(autoConfirm: boolean): Promise<boolean> {
  if (autoConfirm) return true;

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Do you want to perform these actions?',
      default: false,
    },
  ]);

  return confirm;
}

async function executeApply(cwd: string, configPath: string, autoConfirm: boolean): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');

  const backend = new LocalBackend(cwd);
  const stateManager = new StateManager(backend);
  const orchestrator = new Orchestrator(stateManager);
  orchestrator.registerProvider(new LocalProvider());

  // Show plan first
  console.log(chalk.blue('Calculating plan...'));
  const actions = await orchestrator.plan(configContent);

  if (actions.every((a) => a.type === 'NO_OP')) {
    console.log(chalk.green('No changes needed.'));
    return;
  }

  displayActions(actions);

  const confirmed = await confirmApply(autoConfirm);
  if (!confirmed) {
    console.log(chalk.yellow('Apply cancelled.'));
    return;
  }

  console.log(chalk.blue('\napplying...'));
  const outputs = await orchestrator.apply(configContent);
  console.log(chalk.green('\nApply complete! Resources: ' + actions.length + ' processed.'));

  if (Object.keys(outputs).length > 0) {
    console.log(chalk.cyan('\nOutputs:'));
    for (const [key, value] of Object.entries(outputs)) console.log(chalk.white(`  ${key} = ${JSON.stringify(value)}`));
  }
}

async function executeApplyFromPlan(cwd: string, planFile: PlanFile, autoConfirm: boolean): Promise<void> {
  const backend = new LocalBackend(cwd);
  const stateManager = new StateManager(backend);
  const orchestrator = new Orchestrator(stateManager);
  orchestrator.registerProvider(new LocalProvider());

  console.log(chalk.blue('Applying from saved plan...'));
  console.log(chalk.gray(`Plan created: ${planFile.timestamp}`));

  const configPath = path.join(cwd, 'main.mini');
  const configContent = await fs.readFile(configPath, 'utf8');
  const currentHash = crypto.createHash('sha256').update(configContent).digest('hex');

  if (currentHash !== planFile.configHash) {
    console.log(chalk.yellow('\nWarning: Configuration has changed since plan was created.'));
    console.log(chalk.yellow('The plan may be stale. Consider running `miniform plan` again.'));
  }

  displayActions(planFile.actions);

  const confirmed = await confirmApply(autoConfirm);
  if (!confirmed) {
    console.log(chalk.yellow('Apply cancelled.'));
    return;
  }

  console.log(chalk.blue('\napplying...'));
  const outputs = await orchestrator.apply(configContent);
  console.log(chalk.green('\nApply complete! Resources: ' + planFile.actions.length + ' processed.'));

  if (Object.keys(outputs).length > 0) {
    console.log(chalk.cyan('\nOutputs:'));
    for (const [key, value] of Object.entries(outputs)) console.log(chalk.white(`  ${key} = ${JSON.stringify(value)}`));
  }
}

export function createApplyCommand() {
  return new Command('apply')
    .description('Create or update infrastructure')
    .option('-y, --yes', 'Approve changes automatically')
    .argument('[plan-file]', 'Plan file to apply (optional)')
    .action(async (planFileArg: string | undefined, options) => {
      const cwd = process.cwd();

      try {
        // Check if argument is a plan file (must be a string that doesn't start with -)
        if (planFileArg && !planFileArg.startsWith('-')) {
          const planContent = await fs.readFile(planFileArg);
          const planData = JSON.parse(planContent.toString('utf8'));

          if (!validatePlanFile(planData)) {
            console.error(chalk.red('Error: Invalid plan file format.'));
            process.exit(1);
          }

          await executeApplyFromPlan(cwd, planData, options.yes);
        } else {
          const configPath = path.join(cwd, 'main.mini');

          try {
            await fs.access(configPath);
          } catch {
            console.error(chalk.red('Error: main.mini not found.'));
            process.exit(1);
          }

          await executeApply(cwd, configPath, options.yes);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('Apply failed:'), message);
        process.exit(1);
      }
    });
}

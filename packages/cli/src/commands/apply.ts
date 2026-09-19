import { Orchestrator, RunEvent } from '@miniform/orchestrator';
import { PlanAction, PlanFile, validatePlanFile } from '@miniform/planner';
import { LocalProvider } from '@miniform/provider-local';
import { LocalBackend, StateManager } from '@miniform/state';
import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
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

function pastTense(actionType: PlanAction['type']): string {
  if (actionType === 'CREATE') return 'created';
  if (actionType === 'UPDATE') return 'updated';
  if (actionType === 'REPLACE') return 'replaced';
  return 'destroyed';
}

function reportEvent(event: RunEvent): void {
  if (event.type === 'applied') console.log(`  ${getActionSymbol(event.action.type)} ${event.action.resourceType}.${event.action.name} ${pastTense(event.action.type)}`);
  if (event.type === 'failed') throw new Error(`${event.action.resourceType}.${event.action.name}: ${event.error.message}`);
}

async function runAndReport(events: AsyncGenerator<RunEvent>): Promise<void> {
  console.log(chalk.blue('\napplying...'));

  let applied = 0;
  let outputs: Record<string, unknown> = {};
  for await (const event of events) {
    reportEvent(event);
    if (event.type === 'applied') applied += 1;
    if (event.type === 'done') outputs = event.outputs;
  }

  console.log(chalk.green(`\nApply complete! Resources: ${applied} changed.`));

  if (Object.keys(outputs).length > 0) {
    console.log(chalk.cyan('\nOutputs:'));
    for (const [key, value] of Object.entries(outputs)) console.log(chalk.white(`  ${key} = ${JSON.stringify(value)}`));
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

function newOrchestrator(cwd: string): Orchestrator {
  const orchestrator = new Orchestrator(new StateManager(new LocalBackend(cwd)));
  orchestrator.registerProvider(new LocalProvider());

  return orchestrator;
}

async function executeApply(cwd: string, configPath: string, autoConfirm: boolean): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');
  const orchestrator = newOrchestrator(cwd);

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

  await runAndReport(orchestrator.run(configContent));
}

async function executeApplyFromPlan(cwd: string, planFile: PlanFile): Promise<void> {
  const orchestrator = newOrchestrator(cwd);

  console.log(chalk.blue('Applying from saved plan...'));
  console.log(chalk.gray(`Plan created: ${planFile.timestamp}`));

  displayActions(planFile.actions);

  await runAndReport(orchestrator.runPlan(planFile.actions, planFile.config));
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
            console.error(chalk.red('Error: Cannot read this plan file. Run `miniform plan --out <file>` again.'));
            process.exit(1);
          }

          await executeApplyFromPlan(cwd, planData);
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

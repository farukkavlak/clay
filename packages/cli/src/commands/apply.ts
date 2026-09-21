import { Address } from '@clay/contracts';
import { ConfigFiles, DiskFiles, InMemoryFiles, RunEvent } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { PlanAction, PlanFile, validatePlanFile } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { newOrchestrator } from '../engine';
import { describeError } from '../showError';
import { actionSymbol, changesNothing, displayPlan, pastTense } from '../showPlan';

/** A replacement counts once as an add and once as a destroy, as the plan summary counts it. */
function summarize(applied: PlanAction[]): string {
  const count = (type: PlanAction['type']) => applied.filter((action) => action.type === type).length;
  const replaced = count('REPLACE');

  return `${count('CREATE') + replaced} added, ${count('UPDATE')} changed, ${count('DELETE') + replaced} destroyed`;
}

function reportEvent(event: RunEvent): void {
  if (event.type === 'applied') console.log(`  ${actionSymbol(event.action.type)} ${Address.of(event.action).toString()} ${pastTense(event.action.type)}`);
  if (event.type === 'failed') {
    if (event.stateError) console.error(styleText('red', 'The state could not be saved:'), event.stateError.message);
    throw new Error(`${Address.of(event.action).toString()}: ${event.error.message}`);
  }
}

async function runAndReport(events: AsyncGenerator<RunEvent>): Promise<void> {
  console.log(styleText('blue', '\napplying...'));

  const applied: PlanAction[] = [];
  let outputs: Record<string, unknown> = {};
  for await (const event of events) {
    reportEvent(event);
    if (event.type === 'applied') applied.push(event.action);
    if (event.type === 'done') outputs = event.outputs;
  }

  console.log(styleText('green', `\nApply complete! Resources: ${summarize(applied)}.`));

  if (Object.keys(outputs).length > 0) {
    console.log(styleText('cyan', '\nOutputs:'));
    for (const [key, value] of Object.entries(outputs)) console.log(styleText('white', `  ${key} = ${JSON.stringify(value)}`));
  }
}

async function confirmApply(autoConfirm: boolean): Promise<boolean> {
  return autoConfirm || confirm('Do you want to perform these actions?');
}

async function executeApply(cwd: string, configPath: string, autoConfirm: boolean): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');
  const orchestrator = newOrchestrator(cwd, new DiskFiles(cwd));

  console.log(styleText('blue', 'Calculating plan...'));
  const planned = await orchestrator.plan(configContent);

  displayPlan(planned);
  if (changesNothing(planned)) return;

  const confirmed = await confirmApply(autoConfirm);
  if (!confirmed) {
    console.log(styleText('yellow', 'Apply cancelled.'));
    return;
  }

  await runAndReport(orchestrator.runPlan(planned, configContent));
}

/** A saved plan carries the configuration it was made from, so it runs against that and not against whatever is on disk now. */
function filesInPlan(planFile: PlanFile): ConfigFiles {
  return new InMemoryFiles({ ...planFile.modules, [CONFIG_FILE]: planFile.config });
}

async function executeApplyFromPlan(cwd: string, planFile: PlanFile): Promise<void> {
  const orchestrator = newOrchestrator(cwd, filesInPlan(planFile));

  console.log(styleText('blue', 'Applying from saved plan...'));
  console.log(styleText('gray', `Plan created: ${planFile.timestamp}`));

  displayPlan(planFile);
  if (changesNothing(planFile)) return;

  await runAndReport(orchestrator.runPlan(planFile, planFile.config));
}

export function createApplyCommand() {
  return new Command('apply')
    .description('Create or update infrastructure')
    .option('-y, --yes', 'Approve changes automatically')
    .argument('[plan-file]', 'Plan file to apply (optional)')
    .action(async (planFileArg: string | undefined, options) => {
      const cwd = process.cwd();
      let files: ConfigFiles = new DiskFiles(cwd);

      try {
        if (planFileArg && !planFileArg.startsWith('-')) {
          const planContent = await fs.readFile(planFileArg);
          const planData = JSON.parse(planContent.toString('utf8'));

          if (!validatePlanFile(planData)) {
            console.error(styleText('red', 'Error: Cannot read this plan file. Run `clay plan --out <file>` again.'));
            process.exit(1);
          }

          files = filesInPlan(planData);
          await executeApplyFromPlan(cwd, planData);
        } else {
          const configPath = path.join(cwd, CONFIG_FILE);

          try {
            await fs.access(configPath);
          } catch {
            console.error(styleText('red', `Error: ${CONFIG_FILE} not found.`));
            process.exit(1);
          }

          await executeApply(cwd, configPath, options.yes);
        }
      } catch (error: unknown) {
        console.error(styleText('red', 'Apply failed:'), describeError(error, files));
        process.exit(1);
      }
    });
}

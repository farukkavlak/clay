import { Address, Output } from '@clay/contracts';
import { ConfigFiles, DiskFiles, InMemoryFiles, RecordingFiles, RunEvent } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { changedOutside, parsePlanFile, Plan, PlanAction, PlanFile } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { actionLine, changesNothing, displayPlan, readLine } from '../showPlan';
import { refreshOption } from '../refreshOption';

/** Counts as the plan summary does: a replace is one add and one destroy. */
function summarize(applied: PlanAction[], forgotten: number): string {
  const count = (type: PlanAction['type']) => applied.filter((action) => action.type === type).length;
  const replaced = count('REPLACE');
  const moved = applied.filter((action) => action.movedFrom).length;

  return `${count('CREATE') + replaced} added, ${count('UPDATE')} changed, ${count('DELETE') + replaced} destroyed${moved > 0 ? `, ${moved} moved` : ''}${forgotten > 0 ? `, ${forgotten} forgotten` : ''}`;
}

/** Resources deleted outside Clay that apply drops from state without an action. */
function forgotten(plan: Plan): number {
  const acted = new Set(plan.actions.map((action) => Address.of(action).toString()));

  return changedOutside(plan).filter((drift) => !Object.hasOwn(plan.prior, drift.address) && !acted.has(drift.address)).length;
}

function reportEvent(event: RunEvent): void {
  if (event.type === 'applied') console.log(actionLine(event.action, false));
  if (event.type === 'read') console.log(readLine(event.address, false));
  if (event.type === 'failed') {
    if (event.stateError) console.error(styleText('red', 'The state could not be saved:'), event.stateError.message);
    throw new Error(`${Address.of(event.action).toString()}: ${event.error.message}`);
  }
}

async function runAndReport(events: AsyncGenerator<RunEvent>, forgotten: number): Promise<void> {
  console.log(styleText('blue', '\napplying...'));

  const applied: PlanAction[] = [];
  let outputs: Record<string, Output> = {};
  for await (const event of events) {
    reportEvent(event);
    if (event.type === 'applied') applied.push(event.action);
    if (event.type === 'done') outputs = event.outputs;
  }

  console.log(styleText('green', `\nApply complete! Resources: ${summarize(applied, forgotten)}.`));

  if (Object.keys(outputs).length > 0) {
    console.log(styleText('cyan', '\nOutputs:'));
    for (const [key, { value }] of Object.entries(outputs)) console.log(styleText('white', `  ${key} = ${JSON.stringify(value)}`));
  }
}

async function confirmApply(autoConfirm: boolean): Promise<boolean> {
  return autoConfirm || confirm('Do you want to perform these actions?');
}

function configFiles(config: string, modules: Record<string, string>): ConfigFiles {
  return new InMemoryFiles({ ...modules, [CONFIG_FILE]: config });
}

interface PlannedApply {
  plan: Plan;
  config: string;
  /** What the plan read, so the run does not read files changed while the question was open. */
  files: ConfigFiles;
}

async function planFromDisk(cwd: string, recording: RecordingFiles, config: string, refresh: boolean): Promise<PlannedApply> {
  console.log(styleText('blue', 'Calculating plan...'));
  const plan = await newOrchestrator(cwd, recording).plan(config, { refresh });

  return { plan, config, files: configFiles(config, recording.snapshot()) };
}

async function executeApply(cwd: string, { plan, config, files }: PlannedApply, autoConfirm: boolean): Promise<void> {
  displayPlan(plan);
  if (changesNothing(plan)) return;

  const confirmed = await confirmApply(autoConfirm);
  if (!confirmed) {
    console.log(styleText('yellow', 'Apply cancelled.'));
    return;
  }

  await runAndReport(newOrchestrator(cwd, files).runPlan(plan, config), forgotten(plan));
}

/** Errors name the user's file and say what to do. */
async function readPlanFile(planFileArg: string, files: ConfigFiles): Promise<PlanFile> {
  let content: string;

  try {
    content = await fs.readFile(planFileArg, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    throw new Error(`${planFileArg} not found.`, { cause: error });
  }

  try {
    return parsePlanFile(content, planFileArg);
  } catch (error) {
    throw new Error(`${describeError(error, files)}. Run \`clay plan --out <file>\` again.`, { cause: error });
  }
}

async function executeApplyFromPlan(cwd: string, planFile: PlanFile, files: ConfigFiles): Promise<void> {
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Applying from saved plan...'));
  console.log(styleText('gray', `Plan created: ${planFile.timestamp}`));

  displayPlan(planFile);
  if (changesNothing(planFile)) return;

  await runAndReport(orchestrator.runPlan(planFile, planFile.config), forgotten(planFile));
}

export function createApplyCommand() {
  return new Command('apply')
    .description('Create or update infrastructure')
    .option('-y, --yes', 'Approve changes automatically')
    .addOption(refreshOption())
    .argument('[plan-file]', 'Plan file to apply (optional)')
    .action(async (planFileArg: string | undefined, options) => {
      const cwd = process.cwd();
      const recording = new RecordingFiles(new DiskFiles(cwd));
      let files: ConfigFiles = recording;

      try {
        if (planFileArg && !planFileArg.startsWith('-')) {
          // The saved plan already chose whether to refresh.
          if (options.refresh !== undefined) throw new Error('--refresh is for a plan: a saved plan is applied as it was made');
          const planData = await readPlanFile(planFileArg, files);

          files = configFiles(planData.config, planData.modules);
          await executeApplyFromPlan(cwd, planData, files);
        } else {
          const config = recording.read(CONFIG_FILE);
          if (config === undefined) {
            console.error(styleText('red', `Error: ${CONFIG_FILE} not found.`));
            process.exit(1);
          }

          const planned = await planFromDisk(cwd, recording, config, options.refresh ?? true);

          files = planned.files;
          await executeApply(cwd, planned, options.yes);
        }
      } catch (error: unknown) {
        console.error(styleText('red', 'Apply failed:'), describeError(error, files));
        process.exit(1);
      }
    });
}

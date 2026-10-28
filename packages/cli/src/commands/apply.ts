import { Address, jsonText, Output, SENSITIVE } from '@clay/contracts';
import { ConfigFiles, DiskFiles, InMemoryFiles, PlanOptions, RecordingFiles, RunEvent } from '@clay/orchestrator';
import { changedOutside, parsePlanFile, Plan, PlanAction, PlanFile } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { interruptible, INTERRUPTED } from '../interruptible';
import { actionLine, changesNothing, destroyedLine, displayPlan, readLine, shownType } from '../showPlan';
import { parallelismOption } from '../parallelismOption';
import { printable } from '../printable';
import { refreshOption } from '../refreshOption';

/** Counts as the plan summary does: a replace is one add and one destroy. */
function summarize(applied: PlanAction[], forgotten: number): string {
  const count = (type: PlanAction['type']) => applied.filter((action) => shownType(action) === type).length;
  const replaced = count('REPLACE');
  // A replace that made the new object first destroys the old one in a delete of its own, which counts there.
  const destroyedWithReplace = applied.filter((action) => shownType(action) === 'REPLACE' && !action.createBeforeDestroy).length;
  const moved = applied.filter((action) => action.movedFrom).length;

  return `${count('CREATE') + replaced} added, ${count('UPDATE')} changed, ${count('DELETE') + destroyedWithReplace} destroyed${moved > 0 ? `, ${moved} moved` : ''}${forgotten > 0 ? `, ${forgotten} forgotten` : ''}`;
}

/** Resources deleted outside Clay that apply drops from state without an action. */
function forgotten(plan: Plan): number {
  // A deposed object's delete leaves the resource itself, which the provider may no longer find, to be forgotten.
  const acted = new Set(plan.actions.filter((action) => !action.deposed).map((action) => Address.of(action).toString()));

  return changedOutside(plan).filter((drift) => !Object.hasOwn(plan.prior, drift.address) && !acted.has(drift.address)).length;
}

function printFailures(failures: string[]): void {
  for (const failure of failures) console.error(styleText('red', 'Failed:'), printable(failure));
}

/** One failure is the error itself; several are printed and counted. */
function failuresError(failures: string[]): Error | undefined {
  if (failures.length <= 1) return failures.length === 1 ? new Error(failures[0]) : undefined;

  printFailures(failures);
  return new Error(`${failures.length} actions failed`);
}

function reportEvent(event: RunEvent, failures: string[]): void {
  if (event.type === 'applied') console.log(actionLine(event.action, false));
  if (event.type === 'destroyed') console.log(destroyedLine(event.action));
  if (event.type === 'read') console.log(readLine(event.address, false));
  if (event.type === 'printed') console.log(`  ${Address.of(event.action).toString()} (${event.provisioner}): ${printable(event.line)}`);
  if (event.type === 'unsaved') console.error(styleText('red', 'The state could not be saved:'), printable(event.error.message));
  if (event.type === 'failed') {
    if (event.stateError) console.error(styleText('red', 'The state could not be saved:'), printable(event.stateError.message));
    failures.push(`${Address.of(event.action).toString()}: ${event.error.message}`);
  }
}

interface Ran {
  applied: PlanAction[];
  failures: string[];
  /** Given only by a run that finished. */
  outputs?: Record<string, Output>;
}

async function collect(events: AsyncGenerator<RunEvent>): Promise<Ran> {
  const ran: Ran = { applied: [], failures: [] };
  try {
    for await (const event of events) {
      reportEvent(event, ran.failures);
      if (event.type === 'applied') ran.applied.push(event.action);
      if (event.type === 'done') ran.outputs = event.outputs;
    }
  } catch (error) {
    // A crash after the failures must not hide them.
    printFailures(ran.failures);
    throw error;
  }

  return ran;
}

async function runAndReport(start: (signal: AbortSignal) => AsyncGenerator<RunEvent>, forgotten: number): Promise<void> {
  console.log(styleText('blue', '\napplying...'));

  const { applied, failures, outputs, interrupted } = await interruptible(async (signal) => ({ ...(await collect(start(signal))), interrupted: signal.aborted }));
  // A run that finished before the interrupt reached it is complete.
  if (interrupted && outputs === undefined) {
    printFailures(failures);
    console.error(styleText('yellow', 'Apply interrupted. What finished is in the state; plan again to see what is left.'));
    process.exit(INTERRUPTED);
  }

  const failed = failuresError(failures);
  if (failed) throw failed;

  console.log(styleText('green', `\nApply complete! Resources: ${summarize(applied, forgotten)}.`));

  if (outputs !== undefined && Object.keys(outputs).length > 0) {
    console.log(styleText('cyan', '\nOutputs:'));
    for (const [key, { value, sensitive }] of Object.entries(outputs)) console.log(styleText('white', `  ${key} = ${sensitive ? SENSITIVE : jsonText(value)}`));
  }
}

async function confirmApply(autoConfirm: boolean): Promise<boolean> {
  return autoConfirm || confirm('Do you want to perform these actions?');
}

interface PlannedApply {
  plan: Plan;
  /** What the plan read, so the run does not read files changed while the question was open. */
  files: ConfigFiles;
}

async function planFromDisk(cwd: string, recording: RecordingFiles, options: PlanOptions): Promise<PlannedApply> {
  console.log(styleText('blue', 'Calculating plan...'));
  const plan = await newOrchestrator(cwd, recording).plan(options);

  return { plan, files: new InMemoryFiles(recording.snapshot()) };
}

async function executeApply(cwd: string, { plan, files }: PlannedApply, autoConfirm: boolean, parallelism?: number): Promise<void> {
  displayPlan(plan);
  if (changesNothing(plan)) return;

  const confirmed = await confirmApply(autoConfirm);
  if (!confirmed) {
    console.error(styleText('yellow', 'Apply cancelled.'));
    process.exit(1);
  }

  await runAndReport((signal) => newOrchestrator(cwd, files).runPlan(plan, { parallelism, signal }), forgotten(plan));
}

/** Errors name the user's file and say what to do. */
async function readPlanFile(planFileArg: string, files: ConfigFiles): Promise<PlanFile> {
  let content: string;

  try {
    content = await fs.readFile(planFileArg, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    throw new Error(`${planFileArg} not found`, { cause: error });
  }

  try {
    return parsePlanFile(content, planFileArg);
  } catch (error) {
    throw new Error(`${describeError(error, files)}. Run \`clay plan --out <file>\` again.`, { cause: error });
  }
}

async function executeApplyFromPlan(cwd: string, planFile: PlanFile, files: ConfigFiles, parallelism?: number): Promise<void> {
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Applying from saved plan...'));
  console.log(styleText('gray', `Plan created: ${planFile.timestamp}`));

  displayPlan(planFile);
  if (changesNothing(planFile)) return;

  await runAndReport((signal) => orchestrator.runPlan(planFile, { parallelism, signal }), forgotten(planFile));
}

export function createApplyCommand() {
  return new Command('apply')
    .description('Create or update infrastructure')
    .option('-y, --yes', 'Approve changes automatically')
    .addOption(refreshOption())
    .addOption(parallelismOption())
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

          files = new InMemoryFiles(planData.files);
          await executeApplyFromPlan(cwd, planData, files, options.parallelism);
        } else {
          const planned = await planFromDisk(cwd, recording, { refresh: options.refresh ?? true, parallelism: options.parallelism });

          files = planned.files;
          await executeApply(cwd, planned, options.yes, options.parallelism);
        }
      } catch (error: unknown) {
        console.error(styleText('red', 'Apply failed:'), describeError(error, files));
        process.exit(1);
      }
    });
}

import { DiskFiles, PlanOptions, RecordingFiles } from '@clay/orchestrator';
import { serializePlan, VariableInput } from '@clay/planner';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { inWorkspace, selectedState } from '../stateFile';
import { printable } from '../printable';
import { displayPlan } from '../showPlan';
import { lockTimeoutOption, lockWait } from '../lockTimeoutOption';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';
import { givenFiles } from '../givenFiles';
import { givenInputs, varOptions } from '../varOptions';
import { releasedAfter } from '../released';

/** Returns the exit code. */
async function executePlan(cwd: string, files: RecordingFiles, options: PlanOptions, lockTimeout: number | undefined, outFile?: string): Promise<number> {
  const { workspace, backend } = await selectedState(cwd, files);
  const manager = new StateManager(backend, lockWait(lockTimeout));
  const orchestrator = newOrchestrator(files, manager);

  console.log(styleText('blue', `Planning${inWorkspace(workspace)}...`));

  return releasedAfter(manager, async () => {
    const planned = await stoppedAtOnce([manager], async () => {
      await manager.lock('plan');
      return orchestrator.plan(options);
    });
    displayPlan(planned);

    if (outFile) {
      await fs.writeFile(outFile, serializePlan(planned, files.snapshot()), 'utf8');
      console.log(styleText('green', `\nPlan saved to: ${printable(outFile)}`));
    }
    return 0;
  });
}

export function createPlanCommand() {
  const [varOption, varFileOption] = varOptions();
  return new Command('plan')
    .description('Show changes required by the current configuration')
    .option('--out <file>', 'Save plan to file')
    .option('--destroy', 'Plan to destroy every object in state')
    .addOption(refreshOption())
    .addOption(parallelismOption())
    .addOption(lockTimeoutOption())
    .addOption(varOption)
    .addOption(varFileOption)
    .action(async (options) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      let variables: VariableInput[] = [];
      let code: number;
      try {
        variables = await givenInputs(cwd, options);
        code = await executePlan(
          cwd,
          files,
          { refresh: options.refresh ?? true, parallelism: options.parallelism, destroy: options.destroy ?? false, variables },
          options.lockTimeout,
          options.out
        );
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, givenFiles(files, variables)));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

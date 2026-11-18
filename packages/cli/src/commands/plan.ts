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
import { changesNothing, displayPlan } from '../showPlan';
import { lockTimeoutOption, lockWait } from '../lockTimeoutOption';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';
import { givenFiles } from '../givenFiles';
import { givenInputs, varOptions } from '../varOptions';
import { releasedAfter } from '../released';

/** What `--detailed-exitcode` exits with when an apply would do something. */
const HAS_CHANGES = 2;

interface PlanFlags {
  lockTimeout: number | undefined;
  out: string | undefined;
  detailedExitcode: boolean;
}

/** Returns the exit code. */
async function executePlan(cwd: string, files: RecordingFiles, options: PlanOptions, { lockTimeout, out, detailedExitcode }: PlanFlags): Promise<number> {
  const { workspace, backend } = await selectedState(cwd, files);
  const manager = new StateManager(backend, lockWait(lockTimeout));
  const orchestrator = newOrchestrator(files, manager, workspace);

  console.log(styleText('blue', `Planning${inWorkspace(workspace)}...`));

  // The 2 is decided after the release: returned from the work, it would hide a lock left behind.
  let changes = false;
  const code = await releasedAfter(manager, async () => {
    const planned = await stoppedAtOnce([manager], async () => {
      await manager.lock('plan');
      return orchestrator.plan(options);
    });
    displayPlan(planned);

    if (out) {
      await fs.writeFile(out, serializePlan(planned, files.snapshot(), workspace), 'utf8');
      console.log(styleText('green', `\nPlan saved to: ${printable(out)}`));
    }
    changes = !changesNothing(planned);
    return 0;
  });
  return code === 0 && detailedExitcode && changes ? HAS_CHANGES : code;
}

export function createPlanCommand() {
  const [varOption, varFileOption] = varOptions();
  return new Command('plan')
    .description('Show changes required by the current configuration')
    .option('--out <file>', 'Save plan to file')
    .option('--destroy', 'Plan to destroy every object in state')
    .option('--detailed-exitcode', 'Exit 0 when an apply would do nothing, 2 when it would do something, 1 on an error')
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
          { lockTimeout: options.lockTimeout, out: options.out, detailedExitcode: options.detailedExitcode ?? false }
        );
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, givenFiles(files, variables)));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

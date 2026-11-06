import { DiskFiles, PlanOptions, RecordingFiles } from '@clay/orchestrator';
import { serializePlan } from '@clay/planner';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { stateFile } from '../stateFile';
import { printable } from '../printable';
import { displayPlan } from '../showPlan';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';
import { releasedAfter } from '../released';

/** Returns the exit code. */
async function executePlan(cwd: string, files: RecordingFiles, options: PlanOptions, outFile?: string): Promise<number> {
  const manager = new StateManager(stateFile(cwd, files));
  const orchestrator = newOrchestrator(cwd, files, manager);

  console.log(styleText('blue', 'Planning...'));

  return releasedAfter(manager, async () => {
    const planned = await stoppedAtOnce(manager, async () => {
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
  return new Command('plan')
    .description('Show changes required by the current configuration')
    .option('--out <file>', 'Save plan to file')
    .addOption(refreshOption())
    .addOption(parallelismOption())
    .action(async (options) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      let code: number;
      try {
        code = await executePlan(cwd, files, { refresh: options.refresh ?? true, parallelism: options.parallelism }, options.out);
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

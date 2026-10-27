import { DiskFiles, PlanOptions, RecordingFiles } from '@clay/orchestrator';
import { serializePlan } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { printable } from '../printable';
import { displayPlan } from '../showPlan';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';

async function executePlan(cwd: string, files: RecordingFiles, options: PlanOptions, outFile?: string): Promise<void> {
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Planning...'));

  const planned = await orchestrator.plan(options);
  displayPlan(planned);

  if (outFile) {
    await fs.writeFile(outFile, serializePlan(planned, files.snapshot()), 'utf8');
    console.log(styleText('green', `\nPlan saved to: ${printable(outFile)}`));
  }
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

      try {
        await executePlan(cwd, files, { refresh: options.refresh ?? true, parallelism: options.parallelism }, options.out);
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, files));
        process.exit(1);
      }
    });
}

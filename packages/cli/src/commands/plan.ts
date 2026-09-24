import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { serializePlan } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { displayPlan } from '../showPlan';
import { exists } from '../exists';

async function executePlan(cwd: string, configPath: string, outFile?: string): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');

  const files = new RecordingFiles(new DiskFiles(cwd));
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Planning...'));

  const planned = await orchestrator.plan(configContent);
  displayPlan(planned);

  if (outFile) {
    await fs.writeFile(outFile, serializePlan(planned, configContent, files.snapshot()), 'utf8');
    console.log(styleText('green', `\nPlan saved to: ${outFile}`));
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
        if (!(await exists(configPath))) {
          console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
          process.exit(1);
        }

        await executePlan(cwd, configPath, options.out);
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, new DiskFiles(cwd)));
        process.exit(1);
      }
    });
}

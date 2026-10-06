import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { serializePlan } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { displayPlan } from '../showPlan';
import { refreshOption } from '../refreshOption';

async function executePlan(cwd: string, files: RecordingFiles, configContent: string, refresh: boolean, outFile?: string): Promise<void> {
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Planning...'));

  const planned = await orchestrator.plan(configContent, { refresh });
  displayPlan(planned);

  if (outFile) {
    // main.clay is saved as the plan's config, so the modules leave it out.
    const modules = Object.fromEntries(Object.entries(files.snapshot()).filter(([file]) => file !== CONFIG_FILE));
    await fs.writeFile(outFile, serializePlan(planned, configContent, modules), 'utf8');
    console.log(styleText('green', `\nPlan saved to: ${outFile}`));
  }
}

export function createPlanCommand() {
  return new Command('plan')
    .description('Show changes required by the current configuration')
    .option('--out <file>', 'Save plan to file')
    .addOption(refreshOption())
    .action(async (options) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      try {
        const configContent = files.read(CONFIG_FILE);
        if (configContent === undefined) {
          console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
          process.exit(1);
        }

        await executePlan(cwd, files, configContent, options.refresh ?? true, options.out);
      } catch (error: unknown) {
        console.error(styleText('red', 'Planning failed:'), describeError(error, files));
        process.exit(1);
      }
    });
}

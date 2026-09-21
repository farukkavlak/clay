import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { serializePlan } from '@clay/planner';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { displayPlan } from '../showPlan';

async function executePlan(cwd: string, configPath: string, outFile?: string): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');

  const files = new RecordingFiles(new DiskFiles(cwd));
  const orchestrator = newOrchestrator(cwd, files);

  console.log(styleText('blue', 'Refreshing state...'));

  const planned = await orchestrator.plan(configContent);
  displayPlan(planned);

  if (outFile) {
    const planFile = serializePlan(planned, configContent, files.snapshot());
    await fs.writeFile(outFile, JSON.stringify(planFile, null, 2), 'utf8');
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
        await fs.access(configPath);
      } catch {
        console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
        process.exit(1);
      }

      try {
        await executePlan(cwd, configPath, options.out);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(styleText('red', 'Planning failed:'), message);
        process.exit(1);
      }
    });
}

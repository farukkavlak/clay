import { DiskFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { exists } from '../exists';

async function executeValidate(cwd: string, configPath: string): Promise<void> {
  const configContent = await fs.readFile(configPath, 'utf8');

  const orchestrator = newOrchestrator(cwd, new DiskFiles(cwd));

  await orchestrator.validate(configContent);
}

export function createValidateCommand(): Command {
  return new Command('validate').description('Check the configuration without touching state').action(async () => {
    const cwd = process.cwd();
    const configPath = path.join(cwd, CONFIG_FILE);

    try {
      if (!(await exists(configPath))) {
        console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
        process.exit(1);
      }

      await executeValidate(cwd, configPath);
      console.log(styleText('green', 'Configuration is valid.'));
    } catch (error: unknown) {
      console.error(styleText('red', 'Validation failed:'), describeError(error, new DiskFiles(cwd)));
      process.exit(1);
    }
  });
}

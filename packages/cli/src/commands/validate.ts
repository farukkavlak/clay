import { DiskFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';

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
      await fs.access(configPath);
    } catch {
      console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
      process.exit(1);
    }

    try {
      await executeValidate(cwd, configPath);
      console.log(styleText('green', 'Configuration is valid.'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(styleText('red', 'Validation failed:'), message);
      process.exit(1);
    }
  });
}

import { ConfigFiles, DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';

async function executeValidate(cwd: string, files: ConfigFiles, configContent: string): Promise<void> {
  const orchestrator = newOrchestrator(cwd, files);

  await orchestrator.validate(configContent);
}

export function createValidateCommand(): Command {
  return new Command('validate').description('Check the configuration without touching state').action(async () => {
    const cwd = process.cwd();
    const files = new RecordingFiles(new DiskFiles(cwd));

    try {
      const configContent = files.read(CONFIG_FILE);
      if (configContent === undefined) {
        console.error(styleText('red', `Error: ${CONFIG_FILE} not found in current directory.`));
        process.exit(1);
      }

      await executeValidate(cwd, files, configContent);
      console.log(styleText('green', 'Configuration is valid.'));
    } catch (error: unknown) {
      console.error(styleText('red', 'Validation failed:'), describeError(error, files));
      process.exit(1);
    }
  });
}

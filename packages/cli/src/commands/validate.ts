import { ConfigFiles, DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { newOrchestrator } from '../engine';
import { describeError } from '../describeError';
import { namedBackend } from '../stateFile';

async function executeValidate(cwd: string, files: ConfigFiles): Promise<void> {
  await newOrchestrator(cwd, files, new StateManager(namedBackend(cwd, files))).validate();
}

export function createValidateCommand(): Command {
  return new Command('validate').description('Check the configuration without touching state').action(async () => {
    const cwd = process.cwd();
    const files = new RecordingFiles(new DiskFiles(cwd));

    try {
      await executeValidate(cwd, files);
      console.log(styleText('green', 'Configuration is valid.'));
    } catch (error: unknown) {
      console.error(styleText('red', 'Validation failed:'), describeError(error, files));
      process.exit(1);
    }
  });
}

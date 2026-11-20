import { ConfigFiles, DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { lockTimeoutOption } from '../lockTimeoutOption';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';
import { givenFiles } from '../givenFiles';
import { givenInputs, varOptions } from '../varOptions';
import { applyFromDisk } from './apply';

export function createDestroyCommand() {
  const [varOption, varFileOption] = varOptions();
  return new Command('destroy')
    .description('Destroy every object in state')
    .option('-y, --yes', 'Approve changes automatically')
    .addOption(refreshOption())
    .addOption(parallelismOption())
    .addOption(lockTimeoutOption())
    .addOption(varOption)
    .addOption(varFileOption)
    .action(async (options) => {
      const cwd = process.cwd();
      const recording = new RecordingFiles(new DiskFiles(cwd));
      let files: ConfigFiles = recording;

      let code: number;
      try {
        // A provider block may read a variable, which then needs a value.
        const variables = await givenInputs(cwd, options);
        files = givenFiles(recording, variables);
        code = await applyFromDisk(cwd, recording, {
          yes: options.yes ?? false,
          refresh: options.refresh ?? true,
          destroy: true,
          parallelism: options.parallelism,
          lockTimeout: options.lockTimeout,
          variables,
        });
      } catch (error: unknown) {
        console.error(styleText('red', 'Destroy failed:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

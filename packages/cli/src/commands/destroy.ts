import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { lockTimeoutOption } from '../lockTimeoutOption';
import { parallelismOption } from '../parallelismOption';
import { refreshOption } from '../refreshOption';
import { applyFromDisk } from './apply';

export function createDestroyCommand() {
  return new Command('destroy')
    .description('Destroy every object in state')
    .option('-y, --yes', 'Approve changes automatically')
    .addOption(refreshOption())
    .addOption(parallelismOption())
    .addOption(lockTimeoutOption())
    .action(async (options) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      let code: number;
      try {
        code = await applyFromDisk(cwd, files, {
          yes: options.yes ?? false,
          refresh: options.refresh ?? true,
          destroy: true,
          parallelism: options.parallelism,
          lockTimeout: options.lockTimeout,
        });
      } catch (error: unknown) {
        console.error(styleText('red', 'Destroy failed:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

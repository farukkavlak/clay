import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { printable } from '../printable';
import { stateFile } from '../stateFile';

export function createForceUnlockCommand(): Command {
  return new Command('force-unlock')
    .description('Release the lock a run that is gone left behind')
    .argument('<id>', 'The lock id the locked state names')
    .action(async (id: string) => {
      const files = new RecordingFiles(new DiskFiles(process.cwd()));
      try {
        const backend = stateFile(process.cwd(), files);
        await backend.forceUnlock(id);
        console.log(styleText('green', printable(`Released lock ${id} on ${backend.location}`)));
      } catch (error) {
        console.error(styleText('red', 'Error releasing the lock:'), describeError(error, files));
        process.exit(1);
      }
    });
}

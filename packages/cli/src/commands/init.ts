import { emptyState } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { stateFile } from '../stateFile';

export function createInitCommand() {
  return new Command('init').description('Initialize a new Clay workspace').action(async () => {
    const cwd = process.cwd();
    const files = new RecordingFiles(new DiskFiles(cwd));

    console.log(styleText('blue', 'Initializing Clay workspace...'));

    try {
      const stateManager = new StateManager(stateFile(cwd, files));
      const wroteState = await stateManager.writeIfAbsent(emptyState());
      console.log(styleText('green', wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));

      console.log(styleText(['bold', 'green'], '\nClay initialized successfully! 🚀'));
    } catch (error: unknown) {
      console.error(styleText('red', 'Failed to initialize workspace:'), describeError(error, files));
      process.exit(1);
    }
  });
}

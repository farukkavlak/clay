import { emptyState } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { adoptBackend, StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { releasedAfter } from '../released';
import { namedBackend } from '../stateFile';

export function createInitCommand() {
  return new Command('init').description('Initialize a new Clay workspace').action(async () => {
    const cwd = process.cwd();
    const files = new RecordingFiles(new DiskFiles(cwd));

    console.log(styleText('blue', 'Initializing Clay workspace...'));

    let code: number;
    try {
      const backend = namedBackend(cwd, files);
      await adoptBackend(backend, cwd);

      const stateManager = new StateManager(backend);
      code = await releasedAfter(stateManager, async () => {
        await stateManager.lock('init');
        const wroteState = await stateManager.writeIfAbsent(emptyState());
        console.log(styleText('green', wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));

        console.log(styleText(['bold', 'green'], '\nClay initialized successfully! 🚀'));
        return 0;
      });
    } catch (error: unknown) {
      console.error(styleText('red', 'Failed to initialize workspace:'), describeError(error, files));
      code = 1;
    }
    if (code !== 0) process.exit(code);
  });
}

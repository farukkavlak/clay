import { emptyState } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

export function createInitCommand() {
  return new Command('init').description('Initialize a new Clay workspace').action(async () => {
    const cwd = process.cwd();

    console.log(styleText('blue', 'Initializing Clay workspace...'));

    try {
      const stateManager = new StateManager(new LocalBackend(cwd));
      const wroteState = await stateManager.writeIfAbsent(emptyState());
      console.log(styleText('green', wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));

      console.log(styleText(['bold', 'green'], '\nClay initialized successfully! 🚀'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(styleText('red', 'Failed to initialize workspace:'), message);
      process.exit(1);
    }
  });
}

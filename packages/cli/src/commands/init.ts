import { emptyState } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { styleText } from 'node:util';

export function createInitCommand() {
  return new Command('init').description('Initialize a new Clay workspace').action(async () => {
    const cwd = process.cwd();
    const clayDir = path.join(cwd, '.clay');

    console.log(styleText('blue', 'Initializing Clay workspace...'));

    try {
      // mkdir reports the path it made, and nothing when the directory was already there.
      const madeDir = await fs.mkdir(clayDir, { recursive: true });
      console.log(styleText('green', madeDir ? `✓ Created ${clayDir}` : `✓ Found ${clayDir}`));

      const backend = new LocalBackend(cwd);
      const stateManager = new StateManager(backend);
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

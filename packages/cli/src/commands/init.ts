import { LocalBackend, StateManager } from '@miniform/state';
import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createInitCommand() {
  return new Command('init').description('Initialize a new Miniform workspace').action(async () => {
    const cwd = process.cwd();
    const miniformDir = path.join(cwd, '.miniform');

    console.log(chalk.blue('Initializing Miniform workspace...'));

    try {
      // mkdir reports the path it made, and nothing when the directory was already there.
      const madeDir = await fs.mkdir(miniformDir, { recursive: true });
      console.log(chalk.green(madeDir ? `✓ Created ${miniformDir}` : `✓ Found ${miniformDir}`));

      const backend = new LocalBackend(cwd);
      const stateManager = new StateManager(backend);
      const wroteState = await stateManager.writeIfAbsent({ version: 1, resources: {} });
      console.log(chalk.green(wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));

      console.log(chalk.bold.green('\nMiniform initialized successfully! 🚀'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Failed to initialize workspace:'), message);
      process.exit(1);
    }
  });
}

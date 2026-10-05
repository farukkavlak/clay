import { Command } from 'commander';
import { createRequire } from 'node:module';

import { createApplyCommand } from './commands/apply';
import { createInitCommand } from './commands/init';
import { createOutputCommand } from './commands/output';
import { createPlanCommand } from './commands/plan';
import { createStateCommand } from './commands/state';
import { createValidateCommand } from './commands/validate';

// Read from package.json so the version lives in one place.
// The packages compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const { version } = createRequire(__filename)('../package.json') as { version: string };

const program = new Command();

program.name('clay').description('Infrastructure as Code for local resources').version(version);

program.addCommand(createInitCommand());
program.addCommand(createPlanCommand());
program.addCommand(createApplyCommand());
program.addCommand(createOutputCommand());
program.addCommand(createValidateCommand());
program.addCommand(createStateCommand());

// A reader that stops early, as in `clay plan | head`, closes the pipe; that is not an error.
process.stdout.on('error', (error: { code?: string }) => {
  if (error.code !== 'EPIPE') throw error;
});

program.parse();

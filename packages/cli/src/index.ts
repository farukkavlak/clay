import { Command } from 'commander';

import { createApplyCommand } from './commands/apply';
import { createInitCommand } from './commands/init';
import { createOutputCommand } from './commands/output';
import { createPlanCommand } from './commands/plan';
import { createStateCommand } from './commands/state';
import { createValidateCommand } from './commands/validate';

const program = new Command();

program.name('clay').description('Infrastructure as Code for local resources').version('1.0.0');

program.addCommand(createInitCommand());
program.addCommand(createPlanCommand());
program.addCommand(createApplyCommand());
program.addCommand(createOutputCommand());
program.addCommand(createValidateCommand());
program.addCommand(createStateCommand());

program.parse();

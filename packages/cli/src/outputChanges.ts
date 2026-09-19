import { Changes, isUnknown, Plan } from '@clay/planner';
import chalk from 'chalk';

export function changesNothing(plan: Plan): boolean {
  return plan.actions.every((action) => action.type === 'NO_OP') && Object.keys(plan.outputs).length === 0;
}

function show(value: unknown): string {
  return isUnknown(value) ? '(known after apply)' : JSON.stringify(value);
}

export function displayOutputChanges(outputs: Changes): void {
  const names = Object.keys(outputs);
  if (names.length === 0) return;

  console.log(chalk.bold('\nChanges to outputs:\n'));
  for (const name of names) {
    const { old, new: next } = outputs[name];
    if (old === undefined) console.log(`  ${chalk.green('+')} ${name} = ${show(next)}`);
    else if (next === undefined) console.log(`  ${chalk.red('-')} ${name}`);
    else console.log(`  ${chalk.yellow('~')} ${name} = ${show(old)} -> ${show(next)}`);
  }
}

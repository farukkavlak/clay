import { Address } from '@clay/contracts';
import { Changes, isUnknown, Plan, PlanAction } from '@clay/planner';
import { styleText } from 'node:util';

export function changesNothing(plan: Plan): boolean {
  return plan.actions.every((action) => action.type === 'NO_OP') && Object.keys(plan.outputs).length === 0;
}

export function actionSymbol(actionType: PlanAction['type']): string {
  if (actionType === 'CREATE') return styleText('green', '+');
  if (actionType === 'UPDATE') return styleText('yellow', '~');
  if (actionType === 'REPLACE') return styleText('red', '-') + styleText('green', '+');
  if (actionType === 'DELETE') return styleText('red', '-');
  return ' ';
}

export function pastTense(actionType: PlanAction['type']): string {
  if (actionType === 'CREATE') return styleText('green', 'created');
  if (actionType === 'UPDATE') return styleText('yellow', 'updated');
  if (actionType === 'REPLACE') return styleText('red', 'replaced');
  return styleText('red', 'destroyed');
}

function show(value: unknown): string {
  return isUnknown(value) ? '(known after apply)' : JSON.stringify(value);
}

function showOr(value: unknown, whenAbsent: string): string {
  return value === undefined ? whenAbsent : show(value);
}

function displayAction(action: PlanAction): void {
  console.log(`  ${actionSymbol(action.type)} ${Address.of(action).toString()} will be ${pastTense(action.type)}`);

  if ((action.type === 'UPDATE' || action.type === 'REPLACE') && action.changes)
    for (const [key, change] of Object.entries(action.changes)) console.log(`      ${key}: ${showOr(change.old, '(none)')} -> ${showOr(change.new, '(removed)')}`);
}

function displayOutputChanges(outputs: Changes): void {
  const names = Object.keys(outputs);
  if (names.length === 0) return;

  console.log(styleText('bold', '\nChanges to outputs:\n'));
  for (const name of names) {
    const { old, new: next } = outputs[name];
    if (old === undefined) console.log(`  ${styleText('green', '+')} ${name} = ${show(next)}`);
    else if (next === undefined) console.log(`  ${styleText('red', '-')} ${name}`);
    else console.log(`  ${styleText('yellow', '~')} ${name} = ${show(old)} -> ${show(next)}`);
  }
}

/** A replacement counts once as an add and once as a destroy. */
function displaySummary(actions: PlanAction[]): void {
  const count = (type: PlanAction['type']) => actions.filter((action) => action.type === type).length;
  const replaced = count('REPLACE');

  console.log(styleText('bold', `\nPlan: ${count('CREATE') + replaced} to add, ${count('UPDATE')} to change, ${count('DELETE') + replaced} to destroy.`));
}

/** Shows what a plan would do, the same way whether it was just made, is about to run, or was saved to a file. */
export function displayPlan(plan: Plan): void {
  if (changesNothing(plan)) {
    console.log(styleText('green', 'No changes. Your infrastructure matches the configuration.'));
    return;
  }

  const changes = plan.actions.filter((action) => action.type !== 'NO_OP');
  if (changes.length > 0) {
    console.log(styleText('bold', '\nClay will perform the following actions:\n'));
    for (const action of changes) displayAction(action);
  }

  displayOutputChanges(plan.outputs);

  if (changes.length > 0) displaySummary(plan.actions);
  else console.log(styleText('bold', '\nAn apply would only update the outputs in state.'));
}

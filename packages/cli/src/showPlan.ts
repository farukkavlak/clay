import { Address } from '@clay/contracts';
import { Changes, isUnknown, Plan, PlanAction } from '@clay/planner';
import { styleText } from 'node:util';

/** A move changes where state keeps a resource, so a plan that only moves still has work to do. */
function changes(action: PlanAction): boolean {
  return action.type !== 'NO_OP' || action.movedFrom !== undefined;
}

export function changesNothing(plan: Plan): boolean {
  return !plan.actions.some((action) => changes(action)) && Object.keys(plan.outputs).length === 0;
}

function actionSymbol(actionType: PlanAction['type']): string {
  if (actionType === 'CREATE') return styleText('green', '+');
  if (actionType === 'UPDATE') return styleText('yellow', '~');
  if (actionType === 'REPLACE') return styleText('red', '-') + styleText('green', '+');
  if (actionType === 'DELETE') return styleText('red', '-');
  return ' ';
}

function pastTense(actionType: PlanAction['type']): string {
  if (actionType === 'CREATE') return styleText('green', 'created');
  if (actionType === 'UPDATE') return styleText('yellow', 'updated');
  if (actionType === 'REPLACE') return styleText('red', 'replaced');
  return styleText('red', 'destroyed');
}

/** A map as JSON makes one; a number is an ExactNumber, which JSON writes itself. */
function isMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A value known in part shows what is known, and where the rest goes; built piece by piece, since no text a value holds can stand for what is not known. */
function show(value: unknown): string {
  if (isUnknown(value)) return '(known after apply)';
  if (Array.isArray(value)) return `[${value.map((item) => show(item)).join(',')}]`;
  if (isMap(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${show(item)}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

function showOr(value: unknown, whenAbsent: string): string {
  return value === undefined ? whenAbsent : show(value);
}

/** One line for an action, as a plan says it will run (`will be created`) or an apply says it ran (`created`). */
export function actionLine(action: PlanAction, planned: boolean): string {
  const address = Address.of(action).toString();
  const will = planned ? 'will be ' : '';
  if (action.type === 'NO_OP') return `  ${styleText('cyan', '>')} ${address} ${will}moved from ${action.movedFrom}`;

  const moved = action.movedFrom ? `, moved from ${action.movedFrom}` : '';
  return `  ${actionSymbol(action.type)} ${address} ${will}${pastTense(action.type)}${moved}`;
}

function displayAction(action: PlanAction): void {
  console.log(actionLine(action, true));

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

/** A replacement counts once as an add and once as a destroy; a move is counted when there is one. */
function displaySummary(actions: PlanAction[]): void {
  const count = (type: PlanAction['type']) => actions.filter((action) => action.type === type).length;
  const replaced = count('REPLACE');
  const moved = actions.filter((action) => action.movedFrom).length;

  const summary = `${count('CREATE') + replaced} to add, ${count('UPDATE')} to change, ${count('DELETE') + replaced} to destroy${moved > 0 ? `, ${moved} to move` : ''}`;
  console.log(styleText('bold', `\nPlan: ${summary}.`));
}

/** Shows what a plan would do, the same way whether it was just made, is about to run, or was saved to a file. */
export function displayPlan(plan: Plan): void {
  if (changesNothing(plan)) {
    console.log(styleText('green', 'No changes. Your infrastructure matches the configuration.'));
    return;
  }

  const changing = plan.actions.filter((action) => changes(action));
  if (changing.length > 0) {
    console.log(styleText('bold', '\nClay will perform the following actions:\n'));
    for (const action of changing) displayAction(action);
  }

  displayOutputChanges(plan.outputs);

  if (changing.length > 0) displaySummary(plan.actions);
  else console.log(styleText('bold', '\nAn apply would only update the outputs in state.'));
}

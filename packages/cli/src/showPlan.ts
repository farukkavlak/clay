import { Address, isRecord, isUnknown, Output, Schema, SENSITIVE } from '@clay/contracts';
import { changedOutside, Changes, Drift, OutputChanges, Plan, PlanAction } from '@clay/planner';
import { isDeepStrictEqual, styleText } from 'node:util';

import { typeName } from './typeName';

/** A move changes state, so a plan that only moves still has work to do. */
function changes(action: PlanAction): boolean {
  return action.type !== 'NO_OP' || action.movedFrom !== undefined;
}

/** Apply writes drift into state, so a plan that found drift has work to do. */
export function changesNothing(plan: Plan): boolean {
  return !plan.actions.some((action) => changes(action)) && Object.keys(plan.outputs).length === 0 && changedOutside(plan).length === 0;
}

/** `will be read during apply` when `planned`, `read` after. */
export function readLine(address: string, planned: boolean): string {
  return `  ${styleText('cyan', '<=')} ${address} ${planned ? 'will be read during apply' : 'read'}`;
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

/** Built by hand, since no JSON text can stand for an unknown inside a value. */
function show(value: unknown): string {
  if (isUnknown(value)) return '(known after apply)';
  if (Array.isArray(value)) return `[${value.map((item) => show(item)).join(',')}]`;
  // Numbers are ExactNumbers, which JSON.stringify writes exactly.
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${show(item)}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

function showOr(value: unknown, whenAbsent: string): string {
  return value === undefined ? whenAbsent : show(value);
}

/** `will be created` when `planned`, `created` after apply. */
export function actionLine(action: PlanAction, planned: boolean): string {
  const address = Address.of(action).toString();
  const will = planned ? 'will be ' : '';
  if (action.type === 'NO_OP') return `  ${styleText('cyan', '>')} ${address} ${will}moved from ${action.movedFrom}`;

  const moved = action.movedFrom ? `, moved from ${action.movedFrom}` : '';
  return `  ${actionSymbol(action.type)} ${address} ${will}${pastTense(action.type)}${moved}`;
}

function without(members: unknown[], others: unknown[]): unknown[] {
  return members.filter((member) => !others.some((other) => isDeepStrictEqual(member, other)));
}

/** Sets have no order, so a change shows the members removed and added. */
function displayMembers(old: unknown[], next: unknown[], indent: string): void {
  const removed = without(old, next);
  const unchanged = old.length - removed.length;

  for (const member of removed) console.log(`${indent}${styleText('red', '-')} ${show(member)}`);
  for (const member of without(next, old)) console.log(`${indent}${styleText('green', '+')} ${show(member)}`);
  if (unchanged > 0) console.log(`${indent}(${unchanged} unchanged)`);
}

function displayChanges(changes: Changes, schema: Schema): void {
  for (const [key, change] of Object.entries(changes)) {
    const isSet = Object.hasOwn(schema, key) && schema[key].type.kind === 'set';
    if (isSet && Array.isArray(change.old) && Array.isArray(change.new)) {
      console.log(`      ${key}:`);
      displayMembers(change.old, change.new, '        ');
    }
    // An unknown, added or removed set has no members on one side to compare.
    else console.log(`      ${key}: ${showOr(change.old, '(none)')} -> ${showOr(change.new, '(removed)')}`);
  }
}

function displayAction(action: PlanAction, schemas: Plan['schemas']): void {
  console.log(actionLine(action, true));

  if ((action.type === 'UPDATE' || action.type === 'REPLACE') && action.changes) displayChanges(action.changes, schemas[action.resourceType]);
}

function displayChangedOutside({ address, changes }: Drift, plan: Plan): void {
  if (!changes) {
    console.log(`  ${styleText('red', 'x')} ${address} was deleted outside Clay`);
    return;
  }

  console.log(`  ${styleText('yellow', '~')} ${address} was changed outside Clay`);
  displayChanges(changes, plan.schemas[plan.prevRun[address].resourceType]);
}

function displayDrift(drift: Drift[], plan: Plan): void {
  if (drift.length === 0) return;

  console.log(styleText('bold', '\nChanged outside Clay:\n'));
  for (const found of drift) displayChangedOutside(found, plan);
}

function membersOf({ type, value }: Output): unknown[] | undefined {
  return type.kind === 'set' && Array.isArray(value) ? value : undefined;
}

/** A set by its members, a type-only change by both types (the values alone would look unchanged), anything else as old -> new. */
function displayOutputChange(name: string, old: Output, next: Output): void {
  const changed = `  ${styleText('yellow', '~')} ${name}`;
  const was = membersOf(old);
  const now = membersOf(next);

  if (isDeepStrictEqual(old.value, next.value)) console.log(`${changed} = ${show(next.value)} (${typeName(old.type)} -> ${typeName(next.type)})`);
  else if (was && now) {
    console.log(`${changed}:`);
    displayMembers(was, now, '      ');
  } else console.log(`${changed} = ${show(old.value)} -> ${show(next.value)}`);
}

/** Hidden when either side is sensitive, so taking the flag off does not print the value it hid. */
function displayOutputChanges(outputs: OutputChanges): void {
  const names = Object.keys(outputs);
  if (names.length === 0) return;

  console.log(styleText('bold', '\nChanges to outputs:\n'));
  for (const name of names) {
    const { old, new: next } = outputs[name];
    if (next === undefined) console.log(`  ${styleText('red', '-')} ${name}`);
    else if (old?.sensitive ?? next.sensitive) console.log(`  ${old ? styleText('yellow', '~') : styleText('green', '+')} ${name} = ${SENSITIVE}`);
    else if (old === undefined) console.log(`  ${styleText('green', '+')} ${name} = ${show(next.value)}`);
    else displayOutputChange(name, old, next);
  }
}

/** A replace counts as one add and one destroy. */
function displaySummary(actions: PlanAction[]): void {
  const count = (type: PlanAction['type']) => actions.filter((action) => action.type === type).length;
  const replaced = count('REPLACE');
  const moved = actions.filter((action) => action.movedFrom).length;

  const summary = `${count('CREATE') + replaced} to add, ${count('UPDATE')} to change, ${count('DELETE') + replaced} to destroy${moved > 0 ? `, ${moved} to move` : ''}`;
  console.log(styleText('bold', `\nPlan: ${summary}.`));
}

export function displayPlan(plan: Plan): void {
  if (changesNothing(plan)) {
    console.log(styleText('green', 'No changes. Your infrastructure matches the configuration.'));
    return;
  }

  const drift = changedOutside(plan);
  displayDrift(drift, plan);

  const changing = plan.actions.filter((action) => changes(action));
  if (changing.length > 0) {
    console.log(styleText('bold', '\nClay will perform the following actions:\n'));
    for (const action of changing) displayAction(action, plan.schemas);
    // Only a change makes a read wait, so reads come with actions. The summary counts no read.
    for (const address of plan.readAtApply) console.log(readLine(address, true));
  }

  displayOutputChanges(plan.outputs);

  if (changing.length > 0) displaySummary(plan.actions);
  else console.log(styleText('bold', `\nAn apply would only update ${drift.length > 0 ? 'the state' : 'the outputs in state'}.`));
}

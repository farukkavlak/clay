import { Address, isRecord, isUnknown, Output, Schema } from '@clay/contracts';
import { changedOutside, Changes, Drift, OutputChanges, Plan, PlanAction } from '@clay/planner';
import { isDeepStrictEqual, styleText } from 'node:util';

import { typeName } from './typeName';

/** A move changes where state keeps a resource, so a plan that only moves still has work to do. */
function changes(action: PlanAction): boolean {
  return action.type !== 'NO_OP' || action.movedFrom !== undefined;
}

/** What the refresh found is written by an apply, so a plan that found something has work to do. */
export function changesNothing(plan: Plan): boolean {
  return !plan.actions.some((action) => changes(action)) && Object.keys(plan.outputs).length === 0 && changedOutside(plan).length === 0;
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

/** A value known in part shows what is known, and where the rest goes; built piece by piece, since no text a value holds can stand for what is not known. */
function show(value: unknown): string {
  if (isUnknown(value)) return '(known after apply)';
  if (Array.isArray(value)) return `[${value.map((item) => show(item)).join(',')}]`;
  // A number is an ExactNumber, which JSON writes itself.
  if (isRecord(value))
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

function without(members: unknown[], others: unknown[]): unknown[] {
  return members.filter((member) => !others.some((other) => isDeepStrictEqual(member, other)));
}

/** A set's members have no order, so a change to one is the members it loses and gains, each under `indent`. */
function displayMembers(old: unknown[], next: unknown[], indent: string): void {
  const removed = without(old, next);
  const unchanged = old.length - removed.length;

  for (const member of removed) console.log(`${indent}${styleText('red', '-')} ${show(member)}`);
  for (const member of without(next, old)) console.log(`${indent}${styleText('green', '+')} ${show(member)}`);
  if (unchanged > 0) console.log(`${indent}(${unchanged} unchanged)`);
}

/** Each changed value, a set by its members where the schema names one. */
function displayChanges(changes: Changes, schema: Schema): void {
  for (const [key, change] of Object.entries(changes)) {
    const isSet = Object.hasOwn(schema, key) && schema[key].type.kind === 'set';
    if (isSet && Array.isArray(change.old) && Array.isArray(change.new)) {
      console.log(`      ${key}:`);
      displayMembers(change.old, change.new, '        ');
    }
    // A set not known yet, or one that comes or goes, has no members on one side to compare.
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

/** The members of a set that is known, and nothing for any other output. */
function membersOf({ type, value }: Output): unknown[] | undefined {
  return type.kind === 'set' && Array.isArray(value) ? value : undefined;
}

/** A set by its members; a value that stays by its two types, since the values alone would show no change. */
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

function displayOutputChanges(outputs: OutputChanges): void {
  const names = Object.keys(outputs);
  if (names.length === 0) return;

  console.log(styleText('bold', '\nChanges to outputs:\n'));
  for (const name of names) {
    const { old, new: next } = outputs[name];
    if (next === undefined) console.log(`  ${styleText('red', '-')} ${name}`);
    else if (old === undefined) console.log(`  ${styleText('green', '+')} ${name} = ${show(next.value)}`);
    else displayOutputChange(name, old, next);
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

  const drift = changedOutside(plan);
  displayDrift(drift, plan);

  const changing = plan.actions.filter((action) => changes(action));
  if (changing.length > 0) {
    console.log(styleText('bold', '\nClay will perform the following actions:\n'));
    for (const action of changing) displayAction(action, plan.schemas);
  }

  displayOutputChanges(plan.outputs);

  if (changing.length > 0) displaySummary(plan.actions);
  else console.log(styleText('bold', `\nAn apply would only update ${drift.length > 0 ? 'the state' : 'the outputs in state'}.`));
}

import { Address, AttributePath, isExact, isMaybe, isRecord, isUnknown, jsonText, memberKey, Output, samePaths, Schema, SENSITIVE, sensitiveUnder } from '@clay/contracts';
import { changedOutside, Changes, Drift, OutputChanges, Plan, PlanAction } from '@clay/planner';
import { isDeepStrictEqual, styleText } from 'node:util';

import { attributeName } from './printable';
import { typeName } from './typeName';

/** A move, or a change of marks or of what a destroy is prevented, changes state. */
function changes(action: PlanAction): boolean {
  return action.type !== 'NO_OP' || action.movedFrom !== undefined || action.marksChange === true || action.protectionChange === true;
}

/** A no-op that changes which parts are sensitive, or whether a destroy is prevented, shows and counts as an update. */
export function shownType(action: PlanAction): PlanAction['type'] {
  return action.marksChange || action.protectionChange ? 'UPDATE' : action.type;
}

/** Apply writes drift into state, so a plan that found drift has work to do. */
export function changesNothing(plan: Plan): boolean {
  return !plan.actions.some((action) => changes(action)) && Object.keys(plan.outputs).length === 0 && changedOutside(plan).length === 0;
}

/** `will be read during apply` when `planned`, `read` after. */
export function readLine(address: string, planned: boolean): string {
  return `  ${styleText('cyan', '<=')} ${address} ${planned ? 'will be read during apply' : 'read'}`;
}

/** A replace's old object destroyed before its new one is made. */
export function destroyedLine(action: PlanAction): string {
  return `  ${styleText('red', '-')} ${Address.of(action).toString()} ${styleText('red', 'destroyed')}, to be made again`;
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

/** Built by hand, since no JSON text can stand for an unknown inside a value. That a part is sensitive, or may be, tells more than that it is not known. */
export function show(value: unknown, sensitive: readonly AttributePath[] = []): string {
  if (sensitive.some((path) => path.length === 0)) return SENSITIVE;
  if (isUnknown(value)) return '(known after apply)';
  if (sensitive.some((path) => path.length === 1 && isMaybe(path))) return SENSITIVE;
  if (Array.isArray(value)) return `[${value.map((item, index) => show(item, sensitiveUnder(sensitive, index))).join(',')}]`;
  // Numbers are ExactNumbers, which JSON text writes exactly.
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${jsonText(key)}:${show(item, sensitiveUnder(sensitive, key))}`)
      .join(',')}}`;

  return jsonText(value);
}

function showOr(value: unknown, whenAbsent: string, sensitive: readonly AttributePath[]): string {
  return value === undefined ? whenAbsent : show(value, sensitive);
}

/** `will be created` when `planned`, `created` after apply. */
export function actionLine(action: PlanAction, planned: boolean): string {
  const address = Address.of(action).toString() + (action.deposed ? ' (deposed object)' : '');
  const will = planned ? 'will be ' : '';
  const type = shownType(action);
  if (type === 'NO_OP') return `  ${styleText('cyan', '>')} ${address} ${will}moved from ${action.movedFrom}`;

  const moved = action.movedFrom ? `, moved from ${action.movedFrom}` : '';
  const first = action.createBeforeDestroy ? ', the new one created first' : '';
  return `  ${actionSymbol(type)} ${address} ${will}${pastTense(type)}${first}${moved}`;
}

function without(members: unknown[], others: unknown[]): unknown[] {
  const keys = new Set(others.map((other) => memberKey(other)));
  return members.filter((member) => !keys.has(memberKey(member)));
}

/** Sets have no order, so a change shows the members removed and added. */
function displayMembers(old: unknown[], next: unknown[], indent: string): void {
  const removed = without(old, next);
  const unchanged = old.length - removed.length;

  for (const member of removed) console.log(`${indent}${styleText('red', '-')} ${show(member)}`);
  for (const member of without(next, old)) console.log(`${indent}${styleText('green', '+')} ${show(member)}`);
  if (unchanged > 0) console.log(`${indent}(${unchanged} unchanged)`);
}

/** `sensitive` holds the parts marked before the change and after it: a part marked on either side is hidden on both. */
function displayChanges(changes: Changes, schema: Schema, sensitive: readonly AttributePath[]): void {
  for (const [key, change] of Object.entries(changes)) {
    const under = sensitiveUnder(sensitive, key);
    const isSet = Object.hasOwn(schema, key) && schema[key].type.kind === 'set';
    if (isSet && under.length === 0 && Array.isArray(change.old) && Array.isArray(change.new)) {
      console.log(`      ${attributeName(key)}:`);
      displayMembers(change.old, change.new, '        ');
    }
    // An unknown, added or removed set has no members on one side to compare, and a sensitive one shows none.
    else console.log(`      ${attributeName(key)}: ${showOr(change.old, '(none)', under)} -> ${showOr(change.new, '(removed)', under)}`);
  }
}

/** A part that may be sensitive is so only by what the apply finds, so the note says it may be. */
function marksNote(before: AttributePath[], after: AttributePath[]): string | undefined {
  if (samePaths(before, after)) return undefined;

  const certain = after.filter((path) => !isMaybe(path) && !isExact(path));
  if (before.length === 0) return certain.length > 0 ? 'will be marked sensitive' : 'may be marked sensitive';
  if (certain.length === 0) return after.length === 0 ? 'will no longer be marked sensitive' : 'may no longer be marked sensitive';
  return 'which parts are sensitive changes';
}

/** Each attribute whose sensitive parts change, whether or not its value does. */
function displayMarks(before: AttributePath[], after: AttributePath[]): void {
  for (const key of new Set([...before, ...after].map(([attribute]) => String(attribute)))) {
    const note = marksNote(sensitiveUnder(before, key), sensitiveUnder(after, key));
    if (note) console.log(`      ${attributeName(key)}: ${note}`);
  }
}

/** Whether the block prevents a destroy, where it now differs from what the last apply kept. */
function displayProtection(before: boolean, after: boolean): void {
  if (before !== after) console.log(`      prevent_destroy: will ${after ? 'be set' : 'no longer be set'}`);
}

function displayAction(action: PlanAction, plan: Plan): void {
  console.log(actionLine(action, true));
  if (shownType(action) !== 'UPDATE' && action.type !== 'REPLACE') return;

  // The plan holds a moved resource where it was before the move.
  const prior = plan.prior[action.movedFrom ?? Address.of(action).toString()];
  const before = prior?.sensitive ?? [];
  const after = action.sensitive ?? [];
  if (action.changes) displayChanges(action.changes, plan.schemas[action.resourceType], [...before, ...after]);
  displayMarks(before, after);
  displayProtection(prior?.preventDestroy === true, action.preventDestroy === true);
}

function displayChangedOutside({ address, changes }: Drift, plan: Plan): void {
  if (!changes) {
    console.log(`  ${styleText('red', 'x')} ${address} was deleted outside Clay`);
    return;
  }

  console.log(`  ${styleText('yellow', '~')} ${address} was changed outside Clay`);
  // A refresh changes values, never marks.
  displayChanges(changes, plan.schemas[plan.prevRun[address].resourceType], plan.prevRun[address].sensitive ?? []);
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
  const count = (type: PlanAction['type']) => actions.filter((action) => shownType(action) === type).length;
  const replaced = count('REPLACE');
  const moved = actions.filter((action) => action.movedFrom).length;
  // One delete of an address destroys all its deposed objects, so a replace that made the new one first adds none beside one already planned.
  const planned = new Set(actions.filter((action) => action.deposed).map((action) => Address.of(action).toString()));
  const destroyed =
    count('DELETE') + actions.filter((action) => shownType(action) === 'REPLACE' && !(action.createBeforeDestroy && planned.has(Address.of(action).toString()))).length;

  const summary = `${count('CREATE') + replaced} to add, ${count('UPDATE')} to change, ${destroyed} to destroy${moved > 0 ? `, ${moved} to move` : ''}`;
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
    for (const action of changing) displayAction(action, plan);
    // Only a change makes a read wait, so reads come with actions. The summary counts no read.
    for (const address of plan.readAtApply) console.log(readLine(address, true));
  }

  displayOutputChanges(plan.outputs);

  if (changing.length > 0) displaySummary(plan.actions);
  else console.log(styleText('bold', `\nAn apply would only update ${drift.length > 0 ? 'the state' : 'the outputs in state'}.`));
}

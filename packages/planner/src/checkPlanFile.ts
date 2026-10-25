import {
  Address,
  AttributePath,
  isAddress,
  isAttributePaths,
  isDependencies,
  isInstanceKey,
  isModulePath,
  isName,
  isOutput,
  isRecord,
  isType,
  parseDataAddress,
  Resource,
  Schema,
} from '@clay/contracts';

import { ActionType, Plan, PLAN_FILE_VERSION, PlanFile } from './Plan';

/** Whether the path exists in the value, so a saved unknown has a place to go back into. */
function lands(value: unknown, path: AttributePath): boolean {
  if (path.length === 0) return true;

  const [step, ...rest] = path;
  if (Array.isArray(value)) return typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < value.length && lands(value[step], rest);

  return isRecord(value) && typeof step === 'string' && Object.hasOwn(value, step) && lands(value[step], rest);
}

/** A path that is a prefix of another would nest an unknown inside an unknown. */
function overlaps(paths: AttributePath[]): boolean {
  return paths.some((path, i) => paths.some((other, j) => i !== j && path.length <= other.length && path.every((step, k) => other[k] === step)));
}

/** Each unknown path must exist in the value, and no two may overlap. */
function isUnknownPaths(change: Record<string, unknown>): boolean {
  const { unknown } = change;
  if (unknown === undefined) return true;

  return isAttributePaths(unknown) && unknown.every((path) => lands(change.new, path)) && !overlaps(unknown);
}

/** Checked here, so a malformed change fails at the file and not deep in the apply. */
function isChanges(changes: unknown): boolean {
  return isRecord(changes) && Object.values(changes).every((change) => isRecord(change) && isUnknownPaths(change));
}

/** Each side present holds a value and its type; only the value may be unknown. */
function isOutputChange(change: unknown): boolean {
  if (!isRecord(change)) return false;

  const inValue = !Array.isArray(change.unknown) || change.unknown.every((path) => Array.isArray(path) && path[0] === 'value');
  return inValue && [change.old, change.new].every((side) => side === undefined || isOutput(side));
}

function isOutputChanges(changes: unknown): boolean {
  return isChanges(changes) && Object.entries(changes as Record<string, unknown>).every(([name, change]) => isName(name) && isOutputChange(change));
}

function isModuleFiles(modules: unknown): modules is Record<string, string> {
  return isRecord(modules) && Object.values(modules).every((content) => typeof content === 'string');
}

/** Only once `isActionAt` has checked each field it reads. */
function addressOf(action: Record<string, unknown>): Address {
  return Address.of(action as Pick<Resource, 'modulePath' | 'resourceType' | 'name' | 'key'>);
}

/** A move may only come from the action's own resource under its count counterpart. */
function isMovedFrom(action: Record<string, unknown>): boolean {
  if (action.movedFrom === undefined) return true;

  return addressOf(action)
    .countCounterparts()
    .some((kept) => kept.toString() === action.movedFrom);
}

const SENDS_VALUES = new Set<ActionType>(['CREATE', 'UPDATE', 'REPLACE']);

/** Create, update and replace carry `planned` and `after`; other actions carry neither. Any may carry which parts are sensitive. */
function carriesValues(action: Record<string, unknown>): boolean {
  const sends = SENDS_VALUES.has(action.type as ActionType);

  const marked = action.sensitive === undefined || isAttributePaths(action.sensitive);

  return marked && [action.planned, action.after].every((values) => (values === undefined ? !sends : sends && isChanges(values)));
}

/** Only a no-op carries the mark of a change that is not one of the values. */
function isNoOpMark(action: Record<string, unknown>, field: 'marksChange' | 'protectionChange'): boolean {
  return action[field] === undefined || (action[field] === true && action.type === 'NO_OP');
}

/** A destroy is prevented by the block a create, update, replace or no-op was planned from; a delete has none. */
function isProtection(action: Record<string, unknown>): boolean {
  const prevents = action.preventDestroy === undefined || (action.preventDestroy === true && action.type !== 'DELETE');

  return prevents && isNoOpMark(action, 'protectionChange');
}

function isCreatedFirst(action: Record<string, unknown>): boolean {
  return action.createBeforeDestroy === undefined || (action.createBeforeDestroy === true && action.type === 'REPLACE');
}

function isDeposed(action: Record<string, unknown>): boolean {
  return action.deposed === undefined || (action.deposed === true && action.type === 'DELETE');
}

/** Only an update or a replace changes an existing resource, so only they hold a path to leave as it is. */
function isIgnored(action: Record<string, unknown>): boolean {
  return action.ignored === undefined || ((action.type === 'UPDATE' || action.type === 'REPLACE') && isAttributePaths(action.ignored));
}

/** What a plan holds beside the values: the marks, the prevented destroy and the paths left as they are. */
function isStateOnly(action: Record<string, unknown>): boolean {
  return isNoOpMark(action, 'marksChange') && isProtection(action) && isIgnored(action) && isDeposed(action) && isCreatedFirst(action);
}

const ACTION_TYPES = new Set<unknown>(['CREATE', 'UPDATE', 'REPLACE', 'DELETE', 'NO_OP'] satisfies ActionType[]);

/** Its kind, the address it runs at and the addresses it was planned after. */
function isActionAt(action: Record<string, unknown>): boolean {
  return (
    ACTION_TYPES.has(action.type) &&
    typeof action.resourceType === 'string' &&
    typeof action.name === 'string' &&
    (action.modulePath === undefined || isModulePath(action.modulePath)) &&
    (action.key === undefined || isInstanceKey(action.key)) &&
    isAddress(addressOf(action).toString()) &&
    isDependencies(action.dependencies)
  );
}

function isAction(action: unknown): boolean {
  return (
    isRecord(action) && isActionAt(action) && isMovedFrom(action) && isStateOnly(action) && (action.changes === undefined || isChanges(action.changes)) && carriesValues(action)
  );
}

const FLAGS = ['required', 'forceNew', 'computed', 'optional', 'kept', 'sensitive'] as const;

function isSchema(schema: unknown): schema is Schema {
  return (
    isRecord(schema) &&
    Object.values(schema).every(
      (definition) => isRecord(definition) && isType(definition.type) && FLAGS.every((flag) => definition[flag] === undefined || typeof definition[flag] === 'boolean')
    )
  );
}

function isSchemas(schemas: unknown): schemas is Record<string, Schema> {
  return isRecord(schemas) && Object.values(schemas).every((schema) => isSchema(schema));
}

/** Each attribute holds a value and its type, as an output does. */
function isDataSources(dataSources: unknown): boolean {
  return isRecord(dataSources) && Object.values(dataSources).every((read) => isRecord(read) && Object.values(read).every((attribute) => isOutput(attribute)));
}

function isDataSensitive(dataSensitive: unknown): boolean {
  return dataSensitive === undefined || (isRecord(dataSensitive) && Object.values(dataSensitive).every((paths) => isAttributePaths(paths)));
}

/** Resources are checked separately, the same way state's are. */
function isPlan(plan: Partial<Plan>): plan is Plan {
  return (
    typeof plan.serial === 'number' &&
    Array.isArray(plan.actions) &&
    plan.actions.every((action) => isAction(action)) &&
    isOutputChanges(plan.outputs) &&
    isSchemas(plan.schemas) &&
    isDataSources(plan.dataSources) &&
    isDataSensitive(plan.dataSensitive) &&
    Array.isArray(plan.readAtApply) &&
    plan.readAtApply.every((address) => typeof address === 'string')
  );
}

/** As `toISOString` writes it, the only form Clay saves. */
function isTimestamp(timestamp: unknown): boolean {
  return typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp;
}

export function validatePlanFile(planFile: unknown): planFile is PlanFile {
  if (!planFile || typeof planFile !== 'object') return false;

  const pf = planFile as Partial<PlanFile>;
  return pf.version === PLAN_FILE_VERSION && isTimestamp(pf.timestamp) && typeof pf.config === 'string' && isModuleFiles(pf.modules) && isPlan(pf);
}

/** Without its type's schema, a resource's sets could not be shown as sets. */
export function checkSchemasCover(plan: Plan, say: (problem: string) => never): void {
  const types = [...plan.actions, ...Object.values(plan.prevRun), ...Object.values(plan.prior)].map((held) => held.resourceType);
  const missing = types.find((type) => !Object.hasOwn(plan.schemas, type));
  if (missing !== undefined) say(`it has no schema for ${missing}`);
}

/** Checked here, so a wrong address fails at the file and not deep in the apply. */
export function checkDataAddresses({ dataSources, dataSensitive = {}, readAtApply }: Plan, say: (problem: string) => never): void {
  for (const address of [...Object.keys(dataSources), ...readAtApply]) parseDataAddress(address, (reason) => say(`"${address}" is not a data source: ${reason}`));

  for (const address of Object.keys(dataSensitive)) if (!Object.hasOwn(dataSources, address)) say(`"${address}" has sensitive parts but no value in the plan`);

  for (const address of readAtApply) if (Object.hasOwn(dataSources, address)) say(`"${address}" is both read and left for the apply`);
}

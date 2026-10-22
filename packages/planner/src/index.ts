import {
  Address,
  AttributePath,
  containsUnknown,
  ExactNumber,
  InstanceKey,
  isAddress,
  isAttributePaths,
  isDependencies,
  isInstanceKey,
  isOutput,
  isModulePath,
  isName,
  isRecord,
  isType,
  isUnknown,
  ModuleStep,
  NestingError,
  NumberError,
  Output,
  own,
  parseDataAddress,
  readPaths,
  readResources,
  Resource,
  samePaths,
  Schema,
  State,
  Type,
  typeAt,
  typeIn,
  UNKNOWN,
  unknownPaths,
  valueAt,
} from '@clay/contracts';
import { ResourceBlock } from '@clay/parser';
import { isDeepStrictEqual } from 'node:util';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

export interface DesiredResource {
  address: Address;
  block: ResourceBlock;
  attributes: Record<string, unknown>;
  /** As the provider plans it after apply; UNKNOWN where only the apply knows a value. */
  after: Record<string, unknown>;
  /** The steps to each sensitive part of the configuration it was given. */
  sensitive: AttributePath[];
  replace: boolean;
  dependencies: string[];
  /** The paths of the existing resource the configuration does not change; left out where it does not exist yet. */
  ignored?: AttributePath[];
  /** Its block says so, or a block that reads it does: a replace makes the new object first. */
  createBeforeDestroy?: true;
  /** Its state address before count was added or removed; the state it was planned against already has the move. */
  movedFrom?: string;
}

/** An undefined `old` means added, an undefined `new` means removed. */
export type Changes = Record<string, { old: unknown; new: unknown }>;

export type OutputChanges = Record<string, { old: Output | undefined; new: Output | undefined }>;

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  /** Its state address before count was added or removed; the move runs before the action. */
  movedFrom?: string;
  /** Apply resolves the attributes again and checks each known value against these. */
  planned?: Record<string, unknown>;
  /** As the provider planned it after apply. */
  after?: Record<string, unknown>;
  /** The steps to each sensitive part of the resource as the plan leaves it, a no-op too. Left out where there is none. */
  sensitive?: AttributePath[];
  /** On a replace: the new object is made first, and the old one is destroyed once what reads it is updated. */
  createBeforeDestroy?: true;
  /** On a delete: it destroys the objects a replace left behind, not the current one. */
  deposed?: true;
  /** On a no-op: the values stay, which parts are sensitive changes. */
  marksChange?: true;
  /** On an update or a replace: the paths held as the state has them, which the apply holds the same. */
  ignored?: AttributePath[];
  /** What the block says, left out where it does not prevent a destroy. A delete is judged by the state's flag instead. */
  preventDestroy?: true;
  /** On a no-op: the values stay, whether the block prevents a destroy changes. */
  protectionChange?: true;
  changes?: Changes;
  dependencies?: string[];
}

export interface Plan {
  serial: number;
  actions: PlanAction[];
  outputs: OutputChanges;
  /** Resources as state held them before refresh. */
  prevRun: Record<string, Resource>;
  /** Resources after refresh, which the actions run against; one that no longer exists is left out. */
  prior: Record<string, Resource>;
  /** Lets a saved plan tell sets from lists without the provider. */
  schemas: Record<string, Schema>;
  /** What each data source read at plan gave, by address, so the apply reads none of them again. */
  dataSources: Record<string, Record<string, Output>>;
  /** The steps to each sensitive part of what a data source read at plan gave, by address. Left out where there is none. */
  dataSensitive?: Record<string, AttributePath[]>;
  /** Data sources the apply reads, after what they read has changed. */
  readAtApply: string[];
}

/** Bump on any change to the file's shape after a release, so an older plan file is refused instead of misread. */
export const PLAN_FILE_VERSION = '31.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** A saved plan applies this, not whatever is on disk later. */
  config: string;
  /** Keyed by path relative to the root configuration. */
  modules: Record<string, string>;
}

function withoutUnknown(value: unknown): unknown {
  if (isUnknown(value)) return null;
  if (Array.isArray(value)) return value.map((item) => withoutUnknown(item));

  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutUnknown(item)])) : value;
}

/** JSON has no unknown, so it is saved as null with its paths listed beside `new`; a marker inside the value could collide with real data. */
function saveChange(change: { old: unknown; new: unknown }): Record<string, unknown> {
  const paths = unknownPaths(change.new);
  if (paths.length === 0) return change;
  if (isUnknown(change.new)) return { old: change.old, unknown: paths };

  return { old: change.old, new: withoutUnknown(change.new), unknown: paths };
}

function saveChanges(changes: Changes): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).map(([name, change]) => [name, saveChange(change)]));
}

/** Saved as changes from nothing, so unknowns are encoded one way. */
function saveValues(values: Record<string, unknown>): Record<string, unknown> {
  return saveChanges(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { old: undefined, new: value }])));
}

function saveAction(action: PlanAction): Record<string, unknown> {
  return {
    ...action,
    ...(action.changes && { changes: saveChanges(action.changes) }),
    ...(action.planned && { planned: saveValues(action.planned) }),
    ...(action.after && { after: saveValues(action.after) }),
  };
}

/** Whether the path exists in the value, so a saved unknown has a place to go back into. */
function lands(value: unknown, path: AttributePath): boolean {
  if (path.length === 0) return true;

  const [step, ...rest] = path;
  if (Array.isArray(value)) return typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < value.length && lands(value[step], rest);

  return isRecord(value) && typeof step === 'string' && Object.hasOwn(value, step) && lands(value[step], rest);
}

function placeUnknown(value: unknown, path: AttributePath): unknown {
  if (path.length === 0) return UNKNOWN;

  const [step, ...rest] = path;
  const container = value as Record<string | number, unknown>;
  container[step] = placeUnknown(container[step], rest);
  return value;
}

function readChanges<T>(saved: Record<string, { old?: T; new?: T; unknown?: AttributePath[] }>): Record<string, { old: T | undefined; new: T | undefined }> {
  return Object.fromEntries(
    Object.entries(saved).map(([name, change]) => [
      name,
      { old: change.old, new: (change.unknown ?? []).reduce<unknown>((value, path) => placeUnknown(value, path), change.new) as T },
    ])
  );
}

export function serializePlan(plan: Plan, configContent: string, modules: Record<string, string>): string {
  const file = {
    version: PLAN_FILE_VERSION,
    timestamp: new Date().toISOString(),
    config: configContent,
    modules,
    serial: plan.serial,
    actions: plan.actions.map((action) => saveAction(action)),
    outputs: saveChanges(plan.outputs),
    prevRun: plan.prevRun,
    prior: plan.prior,
    schemas: plan.schemas,
    dataSources: plan.dataSources,
    dataSensitive: plan.dataSensitive,
    readAtApply: plan.readAtApply,
  };

  return JSON.stringify(file, undefined, 2);
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

/** Plan files are machine-written, so a broken one only needs "plan again", not the reason. */
function planVersion(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) return undefined;

  return typeof parsed.version === 'string' ? parsed.version : undefined;
}

function readUnknownPaths(changes: unknown): void {
  if (!isRecord(changes)) return;

  for (const change of Object.values(changes)) if (isRecord(change) && change.unknown !== undefined) change.unknown = readPaths(change.unknown, 'an index');
}

function readAction(action: Record<string, unknown>): void {
  if (action.key instanceof ExactNumber) action.key = action.key.toSafeInteger('an instance key');
  if (action.sensitive !== undefined) action.sensitive = readPaths(action.sensitive, 'a sensitive index');
  if (action.ignored !== undefined) action.ignored = readPaths(action.ignored, 'an ignored index');
  readUnknownPaths(action.changes);
  readUnknownPaths(action.planned);
  readUnknownPaths(action.after);
  if (Array.isArray(action.modulePath))
    for (const step of action.modulePath) if (isRecord(step) && step.key instanceof ExactNumber) step.key = step.key.toSafeInteger('a module key');
}

/** The serial, action keys, indexes, unknown and sensitive paths are plain numbers; every other number is a value and stays exact. */
function readPlan(content: string): unknown {
  const read = ExactNumber.readJSON(content);
  if (!isRecord(read)) return read;

  if (read.serial instanceof ExactNumber) read.serial = read.serial.toSafeInteger('its serial');
  if (Array.isArray(read.actions)) for (const action of read.actions) if (isRecord(action)) readAction(action);
  readUnknownPaths(read.outputs);
  if (isRecord(read.dataSensitive)) for (const [address, paths] of Object.entries(read.dataSensitive)) read.dataSensitive[address] = readPaths(paths, 'a sensitive index');

  return read;
}

function readValues(saved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(readChanges(saved as Record<string, { new?: unknown; unknown?: AttributePath[] }>)).map(([name, change]) => [name, change.new]));
}

function readSavedAction(action: PlanAction): PlanAction {
  return {
    ...action,
    ...(action.changes && { changes: readChanges(action.changes) }),
    ...(action.planned && { planned: readValues(action.planned) }),
    ...(action.after && { after: readValues(action.after) }),
  };
}

/** Without its type's schema, a resource's sets could not be shown as sets. */
function checkSchemasCover(plan: Plan, say: (problem: string) => never): void {
  const types = [...plan.actions, ...Object.values(plan.prevRun), ...Object.values(plan.prior)].map((held) => held.resourceType);
  const missing = types.find((type) => !Object.hasOwn(plan.schemas, type));
  if (missing !== undefined) say(`it has no schema for ${missing}`);
}

/** Checked here, so a wrong address fails at the file and not deep in the apply. */
function checkDataAddresses({ dataSources, dataSensitive = {}, readAtApply }: Plan, say: (problem: string) => never): void {
  for (const address of [...Object.keys(dataSources), ...readAtApply]) parseDataAddress(address, (reason) => say(`"${address}" is not a data source: ${reason}`));

  for (const address of Object.keys(dataSensitive)) if (!Object.hasOwn(dataSources, address)) say(`"${address}" has sensitive parts but no value in the plan`);

  for (const address of readAtApply) if (Object.hasOwn(dataSources, address)) say(`"${address}" is both read and left for the apply`);
}

export function parsePlanFile(content: string, source: string): PlanFile {
  let parsed: unknown;

  try {
    parsed = readPlan(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${source} is not a plan file: the file is not JSON`, { cause: error });

    if (error instanceof NumberError || error instanceof NestingError) throw new Error(`${source} is not a plan file: ${error.message}`, { cause: error });

    throw error;
  }

  const version = planVersion(parsed);
  if (version !== undefined && version !== PLAN_FILE_VERSION) throw new Error(`${source} was written by another Clay, plan version ${version}`);
  if (!validatePlanFile(parsed)) throw new Error(`${source} is not a plan file`);

  const say = (problem: string): never => {
    throw new Error(`${source} is not a plan file: ${problem}`);
  };
  readResources(parsed.prevRun, 'its prevRun resources', say);
  readResources(parsed.prior, 'its prior resources', say);
  checkSchemasCover(parsed, say);
  checkDataAddresses(parsed, say);

  return {
    ...parsed,
    actions: parsed.actions.map((action) => readSavedAction(action)),
    outputs: readChanges(parsed.outputs),
  };
}

/** Map key order is not a change. */
function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return !isDeepStrictEqual(oldValue, newValue);
}

/** Maps, so an inherited name like `toString` is absent and `__proto__` is an ordinary key. */
function calculateDiff<T>(oldAttrs: Record<string, T>, newAttrs: Record<string, T>): Record<string, { old: T | undefined; new: T | undefined }> | null {
  const before = new Map(Object.entries(oldAttrs));
  const after = new Map(Object.entries(newAttrs));
  const changes = new Map<string, { old: T | undefined; new: T | undefined }>();

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key);
    const newValue = after.get(key);

    if (valueChanged(oldValue, newValue)) changes.set(key, { old: oldValue, new: newValue });
  }

  return changes.size > 0 ? Object.fromEntries(changes) : null;
}

/** A type change is a change: a set and a list with the same members differ. */
export function outputChanges(current: Record<string, Output>, desired: Record<string, Output>): OutputChanges {
  return calculateDiff(current, desired) ?? {};
}

/** A resource changed outside Clay; without `changes` it was deleted. */
export interface Drift {
  address: string;
  changes?: Changes;
}

/** Drift found by refresh: where `prior` differs from `prevRun`. */
export function changedOutside(plan: Plan): Drift[] {
  return Object.entries(plan.prevRun).flatMap(([address, held]) => {
    if (!Object.hasOwn(plan.prior, address)) return [{ address }];

    const changes = calculateDiff(held.attributes, plan.prior[address].attributes);
    return changes ? [{ address, changes }] : [];
  });
}

export interface Mismatch {
  path: AttributePath;
  planned: unknown;
  returned: unknown;
}

function includes(members: unknown[], member: unknown): boolean {
  return members.some((other) => isDeepStrictEqual(other, member));
}

/**
 * Sets have no positions. The set must hold every known planned member, plus at most one extra member per planned unknown,
 * since an unknown may become a new member or one the set already has.
 */
function setMismatches(planned: unknown[], actual: unknown, at: AttributePath): Mismatch[] {
  if (!Array.isArray(actual)) return [{ path: at, planned, returned: actual }];

  const known = planned.filter((member) => !containsUnknown(member));
  const others = actual.filter((member) => !includes(known, member));
  const holds = known.every((member) => includes(actual, member)) && others.length <= planned.length - known.length;

  return holds ? [] : [{ path: at, planned, returned: actual }];
}

type Compare = (type: Type, planned: unknown, actual: unknown, at: AttributePath) => Mismatch[];

function itemMismatches(type: Type, planned: unknown[], actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!Array.isArray(actual) || planned.length !== actual.length) return [{ path: at, planned, returned: actual }];

  return planned.flatMap((item, i) => compare(typeAt(type, i), item, actual[i], [...at, i]));
}

function entryMismatches(type: Type, planned: Record<string, unknown>, actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!isRecord(actual) || !isDeepStrictEqual(Object.keys(planned).sort(), Object.keys(actual).sort())) return [{ path: at, planned, returned: actual }];

  return Object.keys(planned).flatMap((key) => compare(typeAt(type, key), planned[key], actual[key], [...at, key]));
}

/** An unknown may become anything; every known part must match. */
function mismatches(type: Type, planned: unknown, actual: unknown, at: AttributePath): Mismatch[] {
  if (isUnknown(planned)) return [];
  if (type.kind === 'set' && Array.isArray(planned)) return setMismatches(planned, actual, at);
  if (Array.isArray(planned)) return itemMismatches(type, planned, actual, at, mismatches);
  if (isRecord(planned)) return entryMismatches(type, planned, actual, at, mismatches);

  return isDeepStrictEqual(planned, actual) ? [] : [{ path: at, planned, returned: actual }];
}

/** Where the provider's plan at apply differs from the saved plan. An unknown may become anything or stay unknown. */
export function offFinal(schema: Schema, after: Record<string, unknown>, final: Record<string, unknown>): Mismatch[] {
  return [...new Set([...Object.keys(after), ...Object.keys(final)])].flatMap((name) => mismatches(typeIn(schema, name), own(after, name), own(final, name), [name]));
}

/**
 * Where the applied result differs from the plan. A configured value is checked against what it resolved to at apply, which the plan
 * may not have known. The result may hold no unknown.
 */
export function offApply(schema: Schema, after: Record<string, unknown>, inputs: Record<string, unknown>, returned: Record<string, unknown>): Mismatch[] {
  const expected = { ...after, ...inputs };

  return [...new Set([...Object.keys(expected), ...Object.keys(returned)])].flatMap((name) => {
    const unknown = unknownPaths(own(returned, name), [name]);
    if (unknown.length > 0) return unknown.map((path) => ({ path, planned: valueAt(expected, path), returned: UNKNOWN }));

    return mismatches(typeIn(schema, name), own(expected, name), own(returned, name), [name]);
  });
}

/** The first attribute whose value at apply differs from the plan. */
export function offPlan(schema: Schema, planned: Record<string, unknown>, resolved: Record<string, unknown>): { name: string; planned: unknown; resolved: unknown } | undefined {
  for (const name of new Set([...Object.keys(planned), ...Object.keys(resolved)]))
    if (mismatches(typeIn(schema, name), own(planned, name), own(resolved, name), [name]).length > 0) return { name, planned: own(planned, name), resolved: own(resolved, name) };

  return undefined;
}

export function hasChanges(currentAttrs: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return calculateDiff(currentAttrs, after) !== null;
}

function marked({ sensitive }: DesiredResource): Pick<PlanAction, 'sensitive'> {
  return sensitive.length > 0 ? { sensitive } : {};
}

function ignoring({ ignored }: DesiredResource): Pick<PlanAction, 'ignored'> {
  return ignored && ignored.length > 0 ? { ignored } : {};
}

function prevents({ block }: DesiredResource): boolean {
  return block.lifecycle?.preventDestroy === true;
}

function protectedBy(desired: DesiredResource): Pick<PlanAction, 'preventDestroy'> {
  return prevents(desired) ? { preventDestroy: true } : {};
}

/** What an update or a replace holds of its resource beside the values. */
function carriedOver(desired: DesiredResource): Pick<PlanAction, 'sensitive' | 'preventDestroy' | 'ignored' | 'createBeforeDestroy'> {
  return { ...marked(desired), ...protectedBy(desired), ...ignoring(desired), ...(desired.replace && desired.createBeforeDestroy && { createBeforeDestroy: true as const }) };
}

function processExistingResource(actions: PlanAction[], desired: DesiredResource, currentResource: Resource) {
  const moved = desired.movedFrom;
  const changes = calculateDiff(currentResource.attributes, desired.after);

  if (!changes && !desired.replace) {
    actions.push({
      type: 'NO_OP',
      ...desired.address.fields(),
      ...(moved && { movedFrom: moved }),
      ...marked(desired),
      ...protectedBy(desired),
      ...(!samePaths(currentResource.sensitive ?? [], desired.sensitive) && { marksChange: true }),
      ...(prevents(desired) !== (currentResource.preventDestroy === true) && { protectionChange: true }),
      dependencies: desired.dependencies,
    });
    return;
  }

  actions.push({
    type: desired.replace ? 'REPLACE' : 'UPDATE',
    ...desired.address.fields(),
    ...(moved && { movedFrom: moved }),
    planned: desired.attributes,
    after: desired.after,
    ...carriedOver(desired),
    changes: changes ?? {},
    dependencies: desired.dependencies,
  });
}

/** `currentState` already has every move applied. */
export function plan(desiredResources: DesiredResource[], currentState: State): PlanAction[] {
  const actions: PlanAction[] = [];
  const currentMap = new Map<string, Resource>(Object.entries(currentState.resources));
  const desiredMap = new Map<string, DesiredResource>();

  for (const desired of desiredResources) desiredMap.set(desired.address.toString(), desired);

  for (const [key, desired] of desiredMap.entries()) {
    const currentResource = currentMap.get(key);
    if (currentResource) processExistingResource(actions, desired, currentResource);
    else
      actions.push({
        type: 'CREATE',
        ...desired.address.fields(),
        planned: desired.attributes,
        after: desired.after,
        ...marked(desired),
        ...protectedBy(desired),
        dependencies: desired.dependencies,
      });
  }

  for (const [key, resource] of currentMap.entries()) {
    if (desiredMap.has(key)) continue;

    actions.push({
      type: 'DELETE',
      ...Address.of(resource).fields(),
    });
  }

  // Whether or not the resource they were left by is still there.
  for (const address of Object.keys(currentState.deposed ?? {})) actions.push({ type: 'DELETE', deposed: true, ...Address.parse(address).fields() });

  return actions;
}

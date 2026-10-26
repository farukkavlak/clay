import { AttributePath, ExactNumber, isRecord, isUnknown, NestingError, NumberError, readPaths, readResources, UNKNOWN, unknownPaths } from '@clay/contracts';

import { checkDataAddresses, checkSchemasCover, validatePlanFile } from './checkPlanFile';
import { Changes, Plan, PLAN_FILE_VERSION, PlanAction, PlanFile } from './Plan';

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

export function serializePlan(plan: Plan, files: Record<string, string>): string {
  const file = {
    version: PLAN_FILE_VERSION,
    timestamp: new Date().toISOString(),
    files,
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

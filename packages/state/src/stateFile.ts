import { Address, ExactNumber, isInstanceKey, isModulePath, isRecord, NumberError, Resource, State, STATE_VERSION } from '@clay/contracts';

/** What the engine goes on to read without asking: an address is built from the type, the name and the module path, the planner walks `attributes`, and the runner walks `dependencies`. */
function isResource(value: unknown): value is Resource {
  return (
    isRecord(value) &&
    typeof value.resourceType === 'string' &&
    typeof value.name === 'string' &&
    (value.modulePath === undefined || isModulePath(value.modulePath)) &&
    isRecord(value.attributes) &&
    (value.dependencies === undefined || Array.isArray(value.dependencies))
  );
}

function checkResources(resources: Record<string, unknown>, say: (problem: string) => never): void {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isResource(resource)) say(`"${address}" is not a resource`);
    if (resource.key !== undefined && !isInstanceKey(resource.key)) say(`the key of "${address}" is not a key: a key is a whole number or a string`);

    // A step finds an entry by where it is filed, but a delete is built from what it holds.
    const held = Address.of(resource).toString();
    if (held !== address) say(`"${address}" holds ${held}`);
  }
}

/** Only what the engine goes on to trust: a state is read to be planned against, and a wrong shape plans the wrong actions. */
function check(state: unknown, source: string): asserts state is State {
  const say: (problem: string) => never = (problem) => {
    throw new Error(`${source} is not valid state: ${problem}`);
  };

  if (!isRecord(state)) say('it is not an object');

  const { version, serial, outputs, resources } = state;

  if (typeof version !== 'number') say('its version is not a number');
  if (version > STATE_VERSION) throw new Error(`${source} was written by a newer Clay, version ${version}`);
  if (typeof serial !== 'number') say('its serial is not a number');
  if (outputs !== undefined && !isRecord(outputs)) say('its outputs are not a record');
  if (!isRecord(resources)) say('its resources are not a record');

  checkResources(resources, say);
}

export function serializeState(state: State): string {
  return JSON.stringify(state, null, 2);
}

/** An instance key names a resource or a module, as an address does, so it is a JavaScript number too. */
function readKeys(resources: Record<string, unknown>): void {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isRecord(resource)) continue;

    if (resource.key instanceof ExactNumber) resource.key = resource.key.toSafeInteger(`the key of "${address}"`);
    if (Array.isArray(resource.modulePath))
      for (const step of resource.modulePath) if (isRecord(step) && step.key instanceof ExactNumber) step.key = step.key.toSafeInteger(`a module key of "${address}"`);
  }
}

/** The state's own counters are JavaScript numbers; every other number in it is a value, kept exactly. */
function readState(content: string): unknown {
  const read = ExactNumber.readJSON(content);

  if (!isRecord(read)) return read;

  for (const field of ['version', 'serial']) if (read[field] instanceof ExactNumber) read[field] = read[field].toSafeInteger(`its ${field}`);
  if (isRecord(read.resources)) readKeys(read.resources);

  return read;
}

/** `source` names the state in the error, since a backend knows where it read from and this does not. */
export function parseState(content: string, source: string): State {
  let parsed: unknown;

  try {
    parsed = readState(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${source} is not valid state: the file is not JSON`, { cause: error });

    if (error instanceof NumberError) throw new Error(`${source} is not valid state: ${error.message}`, { cause: error });

    throw error;
  }

  check(parsed, source);

  return parsed;
}

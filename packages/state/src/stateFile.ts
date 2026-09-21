import { Resource, State, STATE_VERSION } from '@clay/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the engine goes on to read without asking: the planner walks `attributes`, and the runner walks `dependencies`. */
function isResource(value: unknown): value is Resource {
  return (
    isRecord(value) &&
    typeof value.resourceType === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.attributes) &&
    (value.dependencies === undefined || Array.isArray(value.dependencies))
  );
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

  for (const [key, resource] of Object.entries(resources)) if (!isResource(resource)) say(`"${key}" is not a resource`);
}

export function serializeState(state: State): string {
  return JSON.stringify(state, null, 2);
}

/** `source` names the state in the error, since a backend knows where it read from and this does not. */
export function parseState(content: string, source: string): State {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${source} is not valid state: the file is not JSON`, { cause: error });
  }

  check(parsed, source);

  return parsed;
}

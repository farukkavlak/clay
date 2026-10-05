import { ExactNumber, isOutput, isRecord, NumberError, readResources, State, STATE_VERSION } from '@clay/contracts';

function checkOutputs(outputs: unknown, say: (problem: string) => never): void {
  if (!isRecord(outputs)) say('its outputs are not a record');

  for (const [name, output] of Object.entries(outputs)) if (!isOutput(output)) say(`its output "${name}" is not a value with its type`);
}

/** Checks what the engine relies on; a wrong shape would plan wrong actions. */
function check(state: unknown, source: string): asserts state is State {
  const say: (problem: string) => never = (problem) => {
    throw new Error(`${source} is not valid state: ${problem}`);
  };

  if (!isRecord(state)) say('it is not an object');

  const { version, serial, outputs, resources } = state;

  if (typeof version !== 'number') say('its version is not a number');
  if (version > STATE_VERSION) throw new Error(`${source} was written by a newer Clay, version ${version}`);
  if (version < STATE_VERSION) throw new Error(`${source} was written by an older Clay, version ${version}`);
  if (typeof serial !== 'number') say('its serial is not a number');
  if (outputs !== undefined) checkOutputs(outputs, say);
  readResources(resources, 'its resources', say);
}

export function serializeState(state: State): string {
  return JSON.stringify(state, null, 2);
}

/** The state's counters are plain numbers; every other number is a value and stays exact. */
function readState(content: string): unknown {
  const read = ExactNumber.readJSON(content);

  if (!isRecord(read)) return read;

  for (const field of ['version', 'serial']) if (read[field] instanceof ExactNumber) read[field] = read[field].toSafeInteger(`its ${field}`);

  return read;
}

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

import { ExactNumber, inAddressOrder, isName, isOutput, isRecord, NestingError, NumberError, readDeposed, readResources, State, STATE_VERSION } from '@clay/contracts';

import { replay } from './journal';

type Say = (problem: string) => never;

function checkOutputs(outputs: unknown, say: Say): void {
  if (!isRecord(outputs)) say('its outputs are not a record');

  for (const [name, output] of Object.entries(outputs)) {
    if (!isName(name)) say(`its output "${name}" has a name no configuration can declare`);
    if (!isOutput(output)) say(`its output "${name}" is not a value with its type, or its sensitive is not true`);
  }
}

/** First, since a state of another version, and its journal, may hold what this one cannot read. */
function checkVersion(state: unknown, source: string, say: Say): asserts state is Record<string, unknown> {
  if (!isRecord(state)) say('it is not an object');

  const { version } = state;
  if (typeof version !== 'number') say('its version is not a number');
  if (version > STATE_VERSION) throw new Error(`${source} was written by a newer Clay, version ${version}`);
  if (version < STATE_VERSION) throw new Error(`${source} was written by an older Clay, version ${version}`);
}

/** Checks what the engine relies on; a wrong shape would plan wrong actions. */
function check(state: unknown, say: Say): asserts state is State {
  if (!isRecord(state)) say('it is not an object');

  const { serial, outputs, resources, deposed } = state;

  if (typeof serial !== 'number') say('its serial is not a number');
  if (outputs !== undefined) checkOutputs(outputs, say);
  readResources(resources, 'its resources', say);
  readDeposed(deposed, say);
}

/** A run holds each resource as its action finishes, so the file puts them in address order instead. */
function inOrder(state: State): State {
  return {
    ...state,
    resources: Object.fromEntries(inAddressOrder(state.resources)),
    ...(state.deposed && { deposed: Object.fromEntries(inAddressOrder(state.deposed)) }),
  };
}

export function serializeState(state: State): string {
  return JSON.stringify(inOrder(state), null, 2);
}

/** The state's counters are plain numbers; every other number is a value and stays exact. */
function readState(content: string): unknown {
  const read = ExactNumber.readJSON(content);

  if (!isRecord(read)) return read;

  for (const field of ['version', 'serial']) if (read[field] instanceof ExactNumber) read[field] = read[field].toSafeInteger(`its ${field}`);

  return read;
}

/** What the last run recorded after the state was written whole. */
export interface Journal {
  content: string;
  source: string;
}

export function parseState(content: string, source: string, journal?: Journal): State {
  let parsed: unknown;

  try {
    parsed = readState(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${source} is not valid state: the file is not JSON`, { cause: error });

    if (error instanceof NumberError || error instanceof NestingError) throw new Error(`${source} is not valid state: ${error.message}`, { cause: error });

    throw error;
  }

  const say: Say = (problem) => {
    throw new Error(`${source} is not valid state: ${problem}`);
  };
  checkVersion(parsed, source, say);
  if (journal) replay(parsed, journal.content, journal.source);
  check(parsed, say);

  // The journal adds each resource as its action finished.
  return inOrder(parsed);
}

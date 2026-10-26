import { ExactNumber, isAddress, isRecord, NestingError, NumberError, readDeposed, readResources, State } from '@clay/contracts';

/** What one address holds after an action, which changes no other, and the serial the state has once it is read with the line. */
export function journalLine(state: State, key: string, serial: number): string {
  const resource = Object.hasOwn(state.resources, key) ? state.resources[key] : null;
  const deposed = state.deposed && Object.hasOwn(state.deposed, key) ? state.deposed[key] : null;

  return `${JSON.stringify({ serial, key, resource, deposed })}\n`;
}

type Say = (problem: string) => never;

interface Entry {
  serial: number;
  key: string;
  resource: unknown;
  deposed: unknown;
}

/** Read with exact numbers like the state, so a value comes back as it was written. */
function parseLine(line: string, at: number, say: Say): Entry {
  const read = ExactNumber.readJSON(line);
  if (!isRecord(read)) say(`line ${at} is not an entry`);

  const { serial, key, resource, deposed } = read;
  if (!(serial instanceof ExactNumber)) say(`the serial of line ${at} is not a number`);
  if (typeof key !== 'string' || !isAddress(key)) say(`line ${at} names ${JSON.stringify(key)}, which is not the address of a resource`);
  // A line without one would drop what the address holds.
  if (!Object.hasOwn(read, 'resource') || !Object.hasOwn(read, 'deposed')) say(`line ${at} does not say both what ${key} holds and what it left deposed`);

  return { serial: serial.toSafeInteger('its serial'), key, resource, deposed };
}

/** Checked as the state checks its own entries, so a wrong one is refused here and not carried into the state. */
function checkEntry({ key, resource, deposed }: Entry, say: Say): void {
  if (resource !== null) readResources({ [key]: resource }, 'its resources', say);
  if (deposed !== null) readDeposed({ [key]: deposed }, say);
}

function apply(state: Record<string, unknown>, resources: Record<string, unknown>, { key, resource, deposed }: Entry): void {
  if (resource === null) delete resources[key];
  else resources[key] = resource;

  const held = isRecord(state.deposed) ? state.deposed : {};
  if (deposed === null) delete held[key];
  else held[key] = deposed;

  if (Object.keys(held).length > 0) state.deposed = held;
  else delete state.deposed;
}

/** A line the run was cut off writing has no newline after it. */
function readLine(line: string, at: number, last: boolean, say: Say): Entry | undefined {
  try {
    return parseLine(line, at, say);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (last) return undefined;

    return say(`line ${at} is not JSON`);
  }
}

/** The lines of one run follow each other; a gap means a line is lost and what came after it may be wrong. */
function follows(entry: Entry, serial: number, at: number, say: Say): boolean {
  if (entry.serial > serial + 1) say(`line ${at} has serial ${entry.serial}, but the state before it has ${serial}`);

  return entry.serial === serial + 1;
}

/** Names the line, for a problem that does not. */
function sayAt(say: Say, at: number): Say {
  return (problem) => say(`line ${at}: ${problem}`);
}

function tryReading<T>(read: () => T, say: Say): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof NumberError || error instanceof NestingError) say(error.message);

    throw error;
  }
}

/**
 * Goes over the state as read, before it is checked, each line taking the serial one further. A line at or below the state's serial came
 * before a whole write that holds it, since a whole write removes the journal once it is in place.
 */
export function replay(state: unknown, journal: string, source: string): void {
  if (!isRecord(state) || !isRecord(state.resources)) return;

  const say: Say = (problem) => {
    throw new Error(`${source} is not a valid journal: ${problem}`);
  };
  const lines = journal.split('\n');
  const { resources } = state;

  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    if (last && line === '') break;

    const at = index + 1;
    const entry = tryReading(() => readLine(line, at, last, say), sayAt(say, at));
    if (!entry || typeof state.serial !== 'number' || !follows(entry, state.serial, at, say)) continue;

    checkEntry(entry, sayAt(say, at));
    apply(state, resources, entry);
    state.serial = entry.serial;
  }
}

import { describe, expect, it } from 'vitest';

import { runTogether } from '../../src/run/runTogether';

type Event = string;

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Gives `start <name>`, waits, then `end <name>`, and returns whether it succeeded. */
function task(name: string, log: string[], { ms = 5, succeeds = true, crashes = false } = {}): () => AsyncGenerator<Event, boolean> {
  return async function* () {
    log.push(`begin ${name}`);
    yield `start ${name}`;
    await pause(ms);
    if (crashes) throw new Error(`${name} crashed`);
    log.push(`finish ${name}`);
    yield succeeds ? `end ${name}` : `failed ${name}`;
    return succeeds;
  };
}

const failed = (event: Event) => event.startsWith('failed');

async function collect(run: AsyncGenerator<Event, boolean>): Promise<{ events: Event[]; result: boolean }> {
  const events: Event[] = [];
  while (true) {
    const step = await run.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe('runTogether', () => {
  it('runs the tasks together, up to the limit', async () => {
    const log: string[] = [];
    const run = runTogether([task('a', log), task('b', log), task('c', log)], 2, failed);

    const { events, result } = await collect(run);

    expect(result).toBe(true);
    expect(log.slice(0, 2)).toEqual(['begin a', 'begin b']);
    expect(log.indexOf('begin c')).toBeGreaterThan(log.indexOf('finish a'));
    expect([...events].sort()).toEqual(['end a', 'end b', 'end c', 'start a', 'start b', 'start c']);
  });

  it('gives each task its events in order', async () => {
    const { events } = await collect(runTogether([task('a', []), task('b', [])], 2, failed));

    expect(events.indexOf('start a')).toBeLessThan(events.indexOf('end a'));
    expect(events.indexOf('start b')).toBeLessThan(events.indexOf('end b'));
  });

  it('gives events as they come, not a task at a time', async () => {
    const { events } = await collect(runTogether([task('slow', [], { ms: 30 }), task('quick', [], { ms: 1 })], 2, failed));

    expect(events).toEqual(['start slow', 'start quick', 'end quick', 'end slow']);
  });

  it('starts none after a task fails, lets the running ones finish, and returns false', async () => {
    const log: string[] = [];
    const run = runTogether([task('bad', log, { ms: 1, succeeds: false }), task('slow', log, { ms: 20 }), task('late', log)], 2, failed);

    const { result } = await collect(run);

    expect(result).toBe(false);
    expect(log).toContain('finish slow');
    expect(log).not.toContain('begin late');
  });

  it('gives a deferred event only when nothing is running', async () => {
    const run = runTogether([task('bad', [], { ms: 1, succeeds: false }), task('slow', [], { ms: 20 })], 2, failed);

    const { events } = await collect(run);

    expect(events).toEqual(['start bad', 'start slow', 'end slow', 'failed bad']);
  });

  it('lets the running tasks finish when a task throws, then throws', async () => {
    const log: string[] = [];
    const run = runTogether([task('boom', log, { ms: 1, crashes: true }), task('slow', log, { ms: 20 }), task('late', log)], 2, failed);

    await expect(collect(run)).rejects.toThrow('boom crashed');
    expect(log).toContain('finish slow');
    expect(log).not.toContain('begin late');
  });

  it('waits for the task that is working when its reader stops early', async () => {
    const log: string[] = [];
    const run = runTogether([task('a', log, { ms: 20 }), task('b', log, { ms: 20 })], 2, failed);

    // `a` is working after this; `b` has given its first event and waits to be asked for more.
    await run.next();
    await run.return(false);

    expect(log).toEqual(['begin a', 'begin b', 'finish a']);
  });

  it('returns true for no tasks', async () => {
    expect(await collect(runTogether([], 3, failed))).toEqual({ events: [], result: true });
  });
});

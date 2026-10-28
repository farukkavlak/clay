import { describe, expect, it } from 'vitest';

import { streamed } from '../../src/run/streamed';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('streamed', () => {
  it('gives each event as it is emitted, while the work still runs, and then what the work returns', async () => {
    let finished = false;
    const events = streamed<string, number>(async (emit) => {
      emit('one');
      await pause(20);
      emit('two');
      finished = true;
      return 3;
    });

    expect(await events.next()).toEqual({ done: false, value: 'one' });
    expect(finished).toBe(false);
    expect(await events.next()).toEqual({ done: false, value: 'two' });
    expect(await events.next()).toEqual({ done: true, value: 3 });
  });

  it('throws what the work throws, after the events emitted before it', async () => {
    const events = streamed<string, void>(async (emit) => {
      emit('one');
      throw new Error('broke');
    });

    expect(await events.next()).toEqual({ done: false, value: 'one' });
    await expect(events.next()).rejects.toThrow('broke');
  });

  it('holds a throw that comes while the reader is busy with an event before it', async () => {
    const events = streamed<string, void>(async (emit) => {
      emit('one');
      throw new Error('broke');
    });

    expect(await events.next()).toEqual({ done: false, value: 'one' });
    await pause(5);
    await expect(events.next()).rejects.toThrow('broke');
  });

  it('waits for the work when the reader leaves early', async () => {
    const log: string[] = [];
    const events = streamed<string, void>(async (emit) => {
      emit('one');
      await pause(5);
      log.push('work done');
    });

    await events.next();
    await events.return();
    log.push('reader left');

    expect(log).toEqual(['work done', 'reader left']);
  });
});

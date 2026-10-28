import { describe, expect, it } from 'vitest';

import { Signals } from './signals';

describe('signals', () => {
  it('wakes each wait for a name once it is given, and no other', async () => {
    const signals = new Signals();
    const woken: string[] = [];
    const waits = [signals.wait('a', 500).then(() => woken.push('a1')), signals.wait('a', 500).then(() => woken.push('a2')), signals.wait('b', 50).then(() => woken.push('b'))];

    signals.give('a');
    await Promise.all(waits);

    expect(woken).toEqual(['a1', 'a2', 'b']);
  });

  // A wait for a name not given would run past the test's own timeout.
  it('does not wait for a name already given', async () => {
    const signals = new Signals();
    signals.give('a');

    await expect(signals.wait('a', 60_000)).resolves.toBeUndefined();
  });

  it('stops waiting after the time given when the name never comes', async () => {
    const started = performance.now();

    await new Signals().wait('never', 20);

    expect(performance.now() - started).toBeGreaterThanOrEqual(19);
  });
});

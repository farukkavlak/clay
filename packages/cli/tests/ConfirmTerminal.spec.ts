import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirm } from '../src/confirm';

/** A stream that says it is a terminal, as process.stdin is when a person types the answer. */
function terminalStream(): PassThrough & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> } {
  return Object.assign(new PassThrough(), { isTTY: true, columns: 80, setRawMode: vi.fn() });
}

describe('the confirm prompt on a terminal', () => {
  afterEach(() => vi.restoreAllMocks());

  // In raw mode Ctrl-C reaches readline as a key and never becomes the SIGINT that releases the lock.
  it('does not put the terminal in raw mode', async () => {
    const input = terminalStream();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(terminalStream() as unknown as typeof process.stdout);

    const asked = confirm('Go?');
    input.write('yes\n');

    expect(await asked).toBe(true);
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});

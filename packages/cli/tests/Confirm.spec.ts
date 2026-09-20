import { once } from 'node:events';
import readline from 'node:readline/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirm } from '../src/confirm';

vi.mock('node:readline/promises');

describe('the confirm prompt', () => {
  let terminal: EventTarget & { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    terminal = Object.assign(new EventTarget(), { question: vi.fn(), close: vi.fn() });
    vi.mocked(readline.createInterface).mockReturnValue(terminal as unknown as readline.Interface);
  });

  it.each(['yes', '  yes\t'])('takes %j as approval', async (answer) => {
    terminal.question.mockResolvedValue(answer);

    expect(await confirm('Go?')).toBe(true);
  });

  it.each(['y', 'Y', 'YES', 'no', ''])('refuses %j', async (answer) => {
    terminal.question.mockResolvedValue(answer);

    expect(await confirm('Go?')).toBe(false);
  });

  it('refuses when the input ends before an answer', async () => {
    // An answer that never comes.
    terminal.question.mockImplementation(async () => {
      await once(terminal, 'answer');
      return 'yes';
    });
    const asked = confirm('Go?');
    terminal.dispatchEvent(new Event('close'));

    expect(await asked).toBe(false);
  });

  it('closes the terminal after the answer', async () => {
    terminal.question.mockResolvedValue('yes');

    await confirm('Go?');

    expect(terminal.close).toHaveBeenCalled();
  });
});

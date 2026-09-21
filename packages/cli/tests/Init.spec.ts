import { StateManager } from '@clay/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitCommand } from '../src/commands/init';

vi.mock('@clay/state');

describe('CLI: init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize state', async () => {
    // Mock StateManager
    const writeIfAbsentMock = vi.fn().mockResolvedValue(true);
    vi.mocked(StateManager).mockImplementation(function () {
      return {
        writeIfAbsent: writeIfAbsentMock,
        read: vi.fn(),
        lock: vi.fn(),
        unlock: vi.fn(),
      } as Partial<StateManager> as StateManager;
    });

    // Execute command action directly (commander action handler)
    await createInitCommand().parseAsync(['node', 'clay', 'init']);

    expect(StateManager).toHaveBeenCalledWith(expect.any(Object));
    expect(writeIfAbsentMock).toHaveBeenCalledWith({ version: 1, serial: 0, resources: {} });
  });

  it('should handle errors gracefully', async () => {
    vi.mocked(StateManager).mockImplementation(function () {
      return { writeIfAbsent: vi.fn().mockRejectedValue(new Error('Permission denied')) } as Partial<StateManager> as StateManager;
    });

    // Mock process.exit to prevent test exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createInitCommand().parseAsync(['node', 'clay', 'init']);

    expect(consoleSpy).toHaveBeenCalledWith('Failed to initialize workspace:', 'Permission denied');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should handle non-Error exceptions', async () => {
    vi.mocked(StateManager).mockImplementation(function () {
      return { writeIfAbsent: vi.fn().mockRejectedValue('String error') } as Partial<StateManager> as StateManager;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createInitCommand().parseAsync(['node', 'clay', 'init']);

    expect(consoleSpy).toHaveBeenCalledWith('Failed to initialize workspace:', 'String error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

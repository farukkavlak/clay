import { STATE_VERSION } from '@clay/contracts';
import { backendFrom, StateBackend, StateManager } from '@clay/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitCommand } from '../src/commands/init';

vi.mock('@clay/state');

describe('CLI: init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize state', async () => {
    const writeIfAbsentMock = vi.fn().mockResolvedValue(true);
    vi.mocked(StateManager).mockImplementation(function () {
      return {
        writeIfAbsent: writeIfAbsentMock,
        read: vi.fn(),
        lock: vi.fn(),
        unlock: vi.fn(),
      } as Partial<StateManager> as StateManager;
    });

    const backend = {} as StateBackend;
    vi.mocked(backendFrom).mockReturnValue(backend);

    await createInitCommand().parseAsync(['node', 'clay', 'init']);

    expect(StateManager).toHaveBeenCalledWith(backend);
    expect(writeIfAbsentMock).toHaveBeenCalledWith({ version: STATE_VERSION, serial: 0, resources: {} });
  });

  it('should handle errors gracefully', async () => {
    vi.mocked(StateManager).mockImplementation(function () {
      return {
        lock: vi.fn(),
        writeIfAbsent: vi.fn().mockRejectedValue(new Error('Permission denied')),
        unlockAfter: vi.fn(async (error: unknown) => {
          throw error;
        }),
      } as Partial<StateManager> as StateManager;
    });

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
      return {
        lock: vi.fn(),
        writeIfAbsent: vi.fn().mockRejectedValue('String error'),
        unlockAfter: vi.fn(async (error: unknown) => {
          throw error;
        }),
      } as Partial<StateManager> as StateManager;
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

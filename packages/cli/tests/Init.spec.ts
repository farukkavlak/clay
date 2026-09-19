import { StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitCommand } from '../src/commands/init';

vi.mock('node:fs/promises');
vi.mock('@clay/state');
vi.mock('chalk', () => ({
  default: {
    blue: vi.fn((msg) => msg),
    green: vi.fn((msg) => msg),
    red: vi.fn((msg) => msg),
    bold: {
      green: vi.fn((msg) => msg),
    },
  },
}));

describe('CLI: init command', () => {
  const cwd = process.cwd();
  const clayDir = path.join(cwd, '.clay');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create .clay directory and initialize state', async () => {
    // Mock fs.mkdir to report the directory it made
    vi.mocked(fs.mkdir).mockResolvedValue(clayDir);

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

    expect(fs.mkdir).toHaveBeenCalledWith(clayDir, { recursive: true });
    expect(StateManager).toHaveBeenCalledWith(expect.any(Object));
    expect(writeIfAbsentMock).toHaveBeenCalledWith({ version: 1, serial: 0, resources: {} });
  });

  it('should handle errors gracefully', async () => {
    // Mock fs.mkdir to throw
    const error = new Error('Permission denied');
    vi.mocked(fs.mkdir).mockRejectedValue(error);

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
    // Mock fs.mkdir to throw a string
    vi.mocked(fs.mkdir).mockRejectedValue('String error');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createInitCommand().parseAsync(['node', 'clay', 'init']);

    expect(consoleSpy).toHaveBeenCalledWith('Failed to initialize workspace:', 'String error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

import { LocalBackend, StateManager } from '@miniform/state';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import { createOutputCommand } from '../src/commands/output';

// Mock StateManager
vi.mock('@miniform/state', () => {
  return {
    LocalBackend: vi.fn(() => ({ path: '/tmp/miniform.state.json' })),
    StateManager: vi.fn().mockImplementation(function () {
      return {
        read: vi.fn().mockResolvedValue({ resources: {}, variables: {} }),
      } as unknown as StateManager;
    }),
  };
});

// The command asks the file system whether a state file is there before reading it.
vi.mock('node:fs/promises', () => ({ default: { access: vi.fn() } }));

describe('Output Command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  const testStateDir = '/tmp/.miniform';
  const testStatePath = path.join(testStateDir, 'terraform.tfstate');

  let readMock: Mock;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.clearAllMocks();

    // Setup Mock StateManager
    readMock = vi.fn().mockResolvedValue({ resources: {}, variables: {} });
    vi.mocked(StateManager).mockImplementation(function () {
      return {
        read: readMock,
      } as unknown as StateManager;
    });

    vi.mocked(LocalBackend).mockImplementation(function () {
      return { path: testStatePath } as unknown as LocalBackend;
    });
    vi.mocked(fs.access).mockResolvedValue(void 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should display outputs from state in formatted table', async () => {
    const mockState = {
      resources: {},
      variables: {
        '': {
          my_output: 'test_value',
          another_output: 42,
        },
      },
    };

    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('Outputs:');
    expect(allCalls).toContain('my_output');
    expect(allCalls).toContain('test_value');
    expect(allCalls).toContain('another_output');
    expect(allCalls).toContain('42');
  });

  it('should output JSON format with --json flag', async () => {
    const mockState = {
      resources: {},
      variables: {
        '': {
          my_output: 'test_value',
          number_output: 123,
        },
      },
    };

    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--json', '--state', testStatePath]);

    const calls = consoleLogSpy.mock.calls;
    // Find the call that is JSON (starts with {)
    const jsonArgs = calls.find((args: unknown[]) => typeof args[0] === 'string' && args[0].trim().startsWith('{'));
    expect(jsonArgs).toBeDefined();

    const parsed = JSON.parse(jsonArgs![0] as string);
    expect(parsed).toHaveProperty('my_output', 'test_value');
    expect(parsed).toHaveProperty('number_output', 123);
  });

  it('should handle empty state gracefully', async () => {
    const mockState = {
      resources: {},
      variables: {},
    };

    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No outputs found'));
  });

  it('should handle missing state file', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No state file found'));
    // processExitSpy might or might not be called depending on impl, check logs
  });

  it('should filter out module-scoped variables', async () => {
    const mockState = {
      resources: {},
      variables: {
        '': {
          root_output: 'visible',
        },
        'module.db': {
          module_output: 'hidden',
        },
      },
    };

    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('root_output');
    expect(allCalls).not.toContain('module_output');
  });

  it('should extract values from complex objects', async () => {
    const mockState = {
      resources: {},
      variables: {
        '': {
          obj_out: {
            value: { nested: 'value' }, // Miniform variable structure
          },
          raw_out: {
            simple: 'object', // Raw object without value wrapper
          },
        },
      },
    };

    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('nested');
    expect(allCalls).toContain('simple');
  });

  it('should handle state reading errors', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockRejectedValue(new Error('Corrupt state'));

    const command = createOutputCommand();
    try {
      await command.parseAsync(['node', 'test', '--state', testStatePath]);
    } catch {
      // ignore
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reading outputs'), expect.anything());
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reading outputs'), expect.anything());
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle state with undefined variables', async () => {
    const mockState = {
      resources: {},
      variables: undefined,
    };
    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test', '--state', testStatePath]);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No outputs found'));
  });

  it('should use default state path if not specified', async () => {
    const mockState = {
      resources: {},
      variables: {
        '': {
          default_out: 'default',
        },
      },
    };
    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    // No --state argument
    await command.parseAsync(['node', 'test']);

    expect(LocalBackend).toHaveBeenCalledWith(process.cwd());

    // Check output
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('default_out'));
  });

  it('should handle non-Error exceptions', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    readMock.mockRejectedValue('String Error');

    const command = createOutputCommand();
    try {
      await command.parseAsync(['node', 'test', '--state', testStatePath]);
    } catch {
      // ignore
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reading outputs'), 'String Error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

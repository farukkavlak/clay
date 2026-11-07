import { emptyState, types } from '@clay/contracts';
import { backendFrom, StateBackend, StateManager } from '@clay/state';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import { createOutputCommand } from '../src/commands/output';

vi.mock('@clay/state', () => {
  return {
    backendFrom: vi.fn(() => ({ location: '/tmp/clay.state.json', exists: vi.fn() })),
    checkBackend: vi.fn(),
    StateManager: vi.fn().mockImplementation(function () {
      return {
        read: vi.fn().mockResolvedValue(emptyState()),
      } as unknown as StateManager;
    }),
  };
});

describe('Output Command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  const testStateDir = '/tmp/.clay';
  const testStatePath = path.join(testStateDir, 'clay.state.json');

  let readMock: Mock;
  let existsMock: Mock;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.clearAllMocks();

    readMock = vi.fn().mockResolvedValue(emptyState());
    existsMock = vi.fn().mockResolvedValue(true);
    vi.mocked(StateManager).mockImplementation(function () {
      return {
        read: readMock,
      } as unknown as StateManager;
    });

    vi.mocked(backendFrom).mockReturnValue({ location: testStatePath, exists: existsMock } as unknown as StateBackend);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should display outputs from state in formatted table', async () => {
    const mockState = { ...emptyState(), outputs: { myOutput: { value: 'test_value', type: types.string }, anotherOutput: { value: 42, type: types.number } } };

    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test']);

    const allCalls = consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(allCalls).toContain('Outputs:');
    expect(allCalls).toContain('myOutput = "test_value"');
    expect(allCalls).toContain('anotherOutput = 42');
  });

  it('should handle empty state gracefully', async () => {
    const mockState = { ...emptyState(), outputs: {} };

    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No outputs found'));
  });

  it('should handle state reading errors', async () => {
    readMock.mockRejectedValue(new Error('Corrupt state'));

    const command = createOutputCommand();
    try {
      await command.parseAsync(['node', 'test']);
    } catch {
      // ignore
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reading outputs'), expect.anything());
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should read the state next to the working directory', async () => {
    const mockState = { ...emptyState(), outputs: { defaultOut: { value: 'default', type: types.string } } };
    readMock.mockResolvedValue(mockState);

    const command = createOutputCommand();
    await command.parseAsync(['node', 'test']);

    expect(backendFrom).toHaveBeenCalledWith(undefined, process.cwd(), process.env);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('defaultOut'));
  });

  it('should handle non-Error exceptions', async () => {
    readMock.mockRejectedValue('String Error');

    const command = createOutputCommand();
    try {
      await command.parseAsync(['node', 'test']);
    } catch {
      // ignore
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reading outputs'), 'String Error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

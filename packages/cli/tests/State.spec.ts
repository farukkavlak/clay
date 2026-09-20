import { LocalBackend, StateManager } from '@clay/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStateCommand } from '../src/commands/state';

vi.mock('@clay/state');

describe('CLI: state command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let readMock: ReturnType<typeof vi.fn>;
  let writeMock: ReturnType<typeof vi.fn>;
  let lockMock: ReturnType<typeof vi.fn>;
  let unlockMock: ReturnType<typeof vi.fn>;

  const mockState = {
    version: 1,
    resources: {
      'test.t1': { type: 'Resource', resourceType: 'test', name: 't1', attributes: { id: '1', val: 'foo' } },
      'test.t2': { type: 'Resource', resourceType: 'test', name: 't2', attributes: { id: '2', val: 'bar' } },
    },
  };

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('ProcessExit');
    }) as never);

    readMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(mockState)));
    writeMock = vi.fn().mockResolvedValue(undefined);
    lockMock = vi.fn().mockResolvedValue(undefined);
    unlockMock = vi.fn().mockResolvedValue(undefined);

    vi.mocked(StateManager).mockImplementation(function () {
      return {
        read: readMock,
        write: writeMock,
        lock: lockMock,
        unlock: unlockMock,
      } as unknown as StateManager;
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('should list all resources in state', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'list']);

      expect(readMock).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('test.t1');
      expect(consoleLogSpy).toHaveBeenCalledWith('test.t2');
      expect(consoleLogSpy).toHaveBeenCalledWith('test.t2');
    });

    it('should use custom state path', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'list', '--state', 'custom.json']);

      expect(LocalBackend).toHaveBeenCalledWith(process.cwd(), 'custom.json');
      expect(readMock).toHaveBeenCalled();
    });

    it('should handle undefined resources in state', async () => {
      readMock.mockResolvedValue({ version: 1 }); // No resources
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'list']);

      expect(consoleLogSpy).toHaveBeenCalledWith('The state file is empty.');
      expect(readMock).toHaveBeenCalled();
    });

    it('should handle empty state', async () => {
      readMock.mockResolvedValue({ version: 1, resources: {} });
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'list']);

      expect(consoleLogSpy).toHaveBeenCalledWith('The state file is empty.');
    });

    it('should handle errors during list', async () => {
      readMock.mockRejectedValue(new Error('List Error'));
      const command = createStateCommand();
      try {
        await command.parseAsync(['node', 'clay', 'list']);
      } catch {
        /* ignore process exit */
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything(), 'List Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('show', () => {
    it('should show details of a resource', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'show', 'test.t1']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('# test.t1:'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('resource "test" "t1" {'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('  id = "1"'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('  val = "foo"'));
    });

    it('should handle resource without attributes', async () => {
      readMock.mockResolvedValue({
        version: 1,
        resources: {
          'test.noattr': { type: 'Resource', resourceType: 'test', name: 'noattr' }, // No attributes
        },
      });
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'show', 'test.noattr']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('# test.noattr:'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('resource "test" "noattr" {'));
      expect(consoleLogSpy).toHaveBeenCalledWith('}');
    });

    it('should exit with error if resource not found', async () => {
      const command = createStateCommand();
      try {
        await command.parseAsync(['node', 'clay', 'show', 'missing.res']);
      } catch {
        /* ignore process exit */
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Resource not found: missing.res'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('rm', () => {
    it('should remove a resource from state', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'rm', 'test.t1']);

      expect(lockMock).toHaveBeenCalled();
      expect(writeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resources: {
            'test.t2': expect.anything(),
          },
        })
      );
      // test.t1 should be gone
      const writtenState = writeMock.mock.calls[0][0];
      expect(writtenState.resources['test.t1']).toBeUndefined();
      expect(unlockMock).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('Successfully removed resource.');
    });

    it('should handle missing resource gracefully', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'rm', 'missing.res']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Resource not found in state'));
      expect(unlockMock).toHaveBeenCalled();
    });

    it('should handle errors during rm', async () => {
      readMock.mockRejectedValue(new Error('Rm Error'));
      const command = createStateCommand();
      try {
        await command.parseAsync(['node', 'clay', 'rm', 'test.t1']);
      } catch {
        /* ignore process exit */
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything(), 'Rm Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('mv', () => {
    it('should rename a resource in state', async () => {
      const command = createStateCommand();
      await command.parseAsync(['node', 'clay', 'mv', 'test.t1', 'test.new']);

      expect(lockMock).toHaveBeenCalled();
      expect(writeMock).toHaveBeenCalled();

      const writtenState = writeMock.mock.calls[0][0];
      expect(writtenState.resources['test.t1']).toBeUndefined();
      expect(writtenState.resources['test.new']).toBeDefined();
      expect(writtenState.resources['test.new'].attributes.val).toBe('foo');

      expect(unlockMock).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('Successfully moved resource.');
    });

    it('should fail if source does not exist', async () => {
      const command = createStateCommand();
      try {
        await command.parseAsync(['node', 'clay', 'mv', 'missing', 'new']);
      } catch {
        /* ignore process exit */
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Source resource not found: missing'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(writeMock).not.toHaveBeenCalled();
      expect(unlockMock).toHaveBeenCalled(); // Should unlock even on error
    });

    it('should fail if destination already exists', async () => {
      const command = createStateCommand();
      try {
        await command.parseAsync(['node', 'clay', 'mv', 'test.t1', 'test.t2']);
      } catch {
        /* ignore process exit */
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Destination resource already exists: test.t2'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(writeMock).not.toHaveBeenCalled();
      expect(unlockMock).toHaveBeenCalled();
    });
  });
});

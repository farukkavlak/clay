import { Orchestrator } from '@miniform/orchestrator';
import inquirer from 'inquirer';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../src/commands/apply';

vi.mock('node:fs/promises');
vi.mock('@miniform/orchestrator');
vi.mock('@miniform/planner', async () => {
  const actual = await vi.importActual('@miniform/planner');
  return {
    ...actual,
    validatePlanFile: vi.fn((data) => {
      return data && data.version && data.actions;
    }),
  };
});
vi.mock('inquirer');
vi.mock('chalk', () => ({
  default: {
    blue: vi.fn((m) => m),
    green: vi.fn((m) => m),
    yellow: vi.fn((m) => m),
    red: vi.fn((m) => m),
    cyan: vi.fn((m) => m),
    white: vi.fn((m) => m),
    gray: vi.fn((m) => m),
    bold: vi.fn((m) => m),
  },
}));
vi.mock('node:crypto', () => ({
  default: {
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => 'test-hash'),
    })),
  },
}));

const doneWith = (outputs: Record<string, unknown>) =>
  async function* () {
    yield { type: 'done', outputs };
  };

describe('CLI: apply command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Config-based apply', () => {
    it('should abort if main.mini not found', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('main.mini not found'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should apply changes when confirmed', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([
        { type: 'CREATE', resourceType: 'test', name: 't1' },
        { type: 'UPDATE', resourceType: 'test', name: 't2' },
        { type: 'DELETE', resourceType: 'test', name: 't3' },
        { type: 'NO_OP', resourceType: 'test', name: 't4' },
      ]);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(inquirer.prompt).mockResolvedValue({ confirm: true });

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(planMock).toHaveBeenCalled();
      expect(inquirer.prompt).toHaveBeenCalled();
      expect(runMock).toHaveBeenCalledWith('content');
    });

    it('should print each resource as it is applied', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'CREATE', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(async function* () {
        yield { type: 'applied', action: { type: 'CREATE', resourceType: 'test', name: 't' } };
        yield { type: 'applied', action: { type: 'DELETE', resourceType: 'test', name: 'gone' } };
        yield { type: 'done', outputs: {} };
      });

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform', '--yes']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('+ test.t created'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('- test.gone destroyed'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Resources: 2 changed'));

      consoleSpy.mockRestore();
    });

    it('should skip confirmation with --yes flag', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'CREATE', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      await createApplyCommand().parseAsync(['node', 'miniform', '--yes']);

      expect(inquirer.prompt).not.toHaveBeenCalled();
      expect(runMock).toHaveBeenCalled();
    });

    it('should abort if confirmation declined', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'CREATE', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(inquirer.prompt).mockResolvedValue({ confirm: false });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(runMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('Apply cancelled.');

      consoleSpy.mockRestore();
    });

    it('should skip apply when all actions are NO_OP', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'NO_OP', resourceType: 'test', name: 't' }]);

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(consoleSpy).toHaveBeenCalledWith('No changes needed.');
      expect(inquirer.prompt).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from apply', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'CREATE', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(doneWith({ my_output: 'test_value', another_output: 42 }));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(inquirer.prompt).mockResolvedValue({ confirm: true });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(runMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));

      consoleSpy.mockRestore();
    });

    it('should handle unknown action types gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'UNKNOWN', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(inquirer.prompt).mockResolvedValue({ confirm: true });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      // Should print action but without specific symbol (default case)
      expect(consoleSpy).toHaveBeenCalled();
      // Should invoke apply
      expect(runMock).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Plan file apply', () => {
    it('should run the saved actions against the saved configuration, without asking again', async () => {
      const planFileContent = JSON.stringify({
        version: '2.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({}));
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          run: runMock,
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalledWith([{ type: 'CREATE', resourceType: 'test', name: 't' }], 'saved config');
      expect(runMock).not.toHaveBeenCalled();
      expect(inquirer.prompt).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Applying from saved plan'));

      consoleSpy.mockRestore();
    });

    it('should not read the configuration on disk', async () => {
      const planFileContent = JSON.stringify({
        version: '2.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          run: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalled();
      expect(vi.mocked(fs.readFile).mock.calls.flat().join(' ')).not.toContain('main.mini');

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from plan apply', async () => {
      const planFileContent = JSON.stringify({
        version: '2.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({ planOutput: 'value' }));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          run: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));

      consoleSpy.mockRestore();
    });

    it('should reject invalid plan file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{ "invalid": true }');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform', 'invalid.json']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot read this plan file'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle apply errors gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue([{ type: 'CREATE', resourceType: 'test', name: 't' }]);
      const runMock = vi.fn(async function* () {
        yield { type: 'failed', action: { type: 'CREATE', resourceType: 'test', name: 't' }, error: new Error('disk full') };
      });

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          run: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(inquirer.prompt).mockResolvedValue({ confirm: true });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'miniform']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Apply failed:'), 'test.t: disk full');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  it('should handle non-Error exceptions gracefully', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);

    // Mock fs.readFile to throw a string error
    vi.mocked(fs.readFile).mockRejectedValue('String Error');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createApplyCommand().parseAsync(['node', 'miniform']);

    // Should use String(error)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Apply failed:'), 'String Error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

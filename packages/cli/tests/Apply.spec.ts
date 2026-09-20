import { InMemoryFiles, Orchestrator } from '@clay/orchestrator';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../src/commands/apply';
import { confirm } from '../src/confirm';

vi.mock('node:fs/promises');
// The engine is mocked; Address is a plain value type the commands print with, so it stays real.
vi.mock('@clay/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@clay/orchestrator')>('@clay/orchestrator');
  return {
    ...actual,
    Orchestrator: vi.fn(),
    DiskFiles: vi.fn(),
    InMemoryFiles: vi.fn(),
    RecordingFiles: vi.fn(function () {
      return { snapshot: () => ({}) };
    }),
  };
});
vi.mock('@clay/planner', async () => {
  const actual = await vi.importActual('@clay/planner');
  return {
    ...actual,
    validatePlanFile: vi.fn((data) => {
      return data && data.version && data.actions;
    }),
  };
});
vi.mock('../src/confirm');
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
    it('should abort if main.clay not found', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('main.clay not found'));
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should apply changes when confirmed', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planned = {
        serial: 0,
        actions: [
          { type: 'CREATE', resourceType: 'test', name: 't1' },
          { type: 'UPDATE', resourceType: 'test', name: 't2' },
          { type: 'DELETE', resourceType: 'test', name: 't3' },
          { type: 'NO_OP', resourceType: 'test', name: 't4' },
        ],
        outputs: {},
      };
      const planMock = vi.fn().mockResolvedValue(planned);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(planMock).toHaveBeenCalled();
      expect(confirm).toHaveBeenCalled();
      expect(runMock).toHaveBeenCalledWith(planned, 'content');
    });

    it('should print each resource as it is applied', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(async function* () {
        yield { type: 'applied', action: { type: 'CREATE', resourceType: 'test', name: 't' } };
        yield { type: 'applied', action: { type: 'DELETE', resourceType: 'test', name: 'gone', modulePath: ['m'] } };
        yield { type: 'applied', action: { type: 'REPLACE', resourceType: 'test', name: 'again' } };
        yield { type: 'done', outputs: {} };
      });

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('+ test.t created'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('- module.m.test.gone destroyed'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Resources: 2 added, 0 changed, 2 destroyed'));

      consoleSpy.mockRestore();
    });

    it('should skip confirmation with --yes flag', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

      expect(confirm).not.toHaveBeenCalled();
      expect(runMock).toHaveBeenCalled();
    });

    it('should abort if confirmation declined', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(runMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('Apply cancelled.');

      consoleSpy.mockRestore();
    });

    it('should skip apply when all actions are NO_OP', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't' }], outputs: {} });

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(consoleSpy).toHaveBeenCalledWith('No changes needed.');
      expect(confirm).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should run when only an output changes', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi
        .fn()
        .mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't' }], outputs: { greeting: { old: undefined, new: 'hi' } } });
      const runMock = vi.fn(doneWith({ greeting: 'hi' }));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

      expect(consoleSpy).not.toHaveBeenCalledWith('No changes needed.');
      expect(runMock).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from apply', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(doneWith({ my_output: 'test_value', another_output: 42 }));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(runMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));

      consoleSpy.mockRestore();
    });

    it('should handle unknown action types gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(void 0);
      vi.mocked(fs.readFile).mockResolvedValue('content');

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'UNKNOWN', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

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
        version: '5.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        modules: { 'm/main.clay': 'saved module' },
        serial: 2,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalledWith(expect.objectContaining({ serial: 2, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }] }), 'saved config');
      expect(InMemoryFiles).toHaveBeenCalledWith({ 'm/main.clay': 'saved module' });
      expect(confirm).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Applying from saved plan'));

      consoleSpy.mockRestore();
    });

    it('should not read the configuration on disk', async () => {
      const planFileContent = JSON.stringify({
        version: '5.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        modules: { 'm/main.clay': 'saved module' },
        serial: 2,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalled();
      expect(vi.mocked(fs.readFile).mock.calls.flat().join(' ')).not.toContain('main.clay');

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from plan apply', async () => {
      const planFileContent = JSON.stringify({
        version: '5.0',
        timestamp: '2024-01-01T00:00:00Z',
        config: 'saved config',
        modules: { 'm/main.clay': 'saved module' },
        serial: 2,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({ planOutput: 'value' }));

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));

      consoleSpy.mockRestore();
    });

    it('should reject invalid plan file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{ "invalid": true }');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'invalid.json']);

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

      const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }], outputs: {} });
      const runMock = vi.fn(async function* () {
        yield { type: 'failed', action: { type: 'CREATE', resourceType: 'test', name: 't' }, error: new Error('disk full') };
      });

      vi.mocked(Orchestrator).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

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

    await createApplyCommand().parseAsync(['node', 'clay']);

    // Should use String(error)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Apply failed:'), 'String Error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

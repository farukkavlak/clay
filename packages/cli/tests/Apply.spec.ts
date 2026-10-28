import { Output, types } from '@clay/contracts';
import { InMemoryFiles, Orchestrator } from '@clay/orchestrator';
import { PLAN_FILE_VERSION } from '@clay/planner';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../src/commands/apply';
import { confirm } from '../src/confirm';

vi.mock('node:fs/promises');
// Address is a plain value type the commands print with, so it stays real.
vi.mock('@clay/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@clay/orchestrator')>('@clay/orchestrator');
  return {
    ...actual,
    Orchestrator: { create: vi.fn() },
    DiskFiles: vi.fn(),
    InMemoryFiles: vi.fn(),
    RecordingFiles: vi.fn(function () {
      return { read: vi.fn(), snapshot: () => ({}) };
    }),
  };
});
vi.mock('../src/confirm');

const text = (value: string): Output => ({ value, type: types.string });

const doneWith = (outputs: Record<string, Output>) =>
  async function* () {
    yield { type: 'done', outputs };
  };

describe('CLI: apply command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Config-based apply', () => {
    it('should apply changes when confirmed', async () => {
      const planned = {
        serial: 0,
        actions: [
          { type: 'CREATE', resourceType: 'test', name: 't1' },
          { type: 'UPDATE', resourceType: 'test', name: 't2' },
          { type: 'DELETE', resourceType: 'test', name: 't3' },
          { type: 'NO_OP', resourceType: 'test', name: 't4' },
        ],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      };
      const planMock = vi.fn().mockResolvedValue(planned);
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(planMock).toHaveBeenCalled();
      expect(confirm).toHaveBeenCalled();
      expect(runMock).toHaveBeenCalledWith(planned, { parallelism: undefined, signal: expect.any(AbortSignal) });
    });

    it('should print each resource as it is applied', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(async function* () {
        yield { type: 'applied', action: { type: 'CREATE', resourceType: 'test', name: 't' } };
        yield { type: 'applied', action: { type: 'DELETE', resourceType: 'test', name: 'gone', modulePath: [{ name: 'm' }] } };
        yield { type: 'applied', action: { type: 'REPLACE', resourceType: 'test', name: 'again' } };
        yield { type: 'done', outputs: {} };
      });

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
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
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

      expect(confirm).not.toHaveBeenCalled();
      expect(runMock).toHaveBeenCalled();
    });

    it('exits 1 when the confirmation is declined', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(false);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('ProcessExit');
      }) as never);

      await expect(createApplyCommand().parseAsync(['node', 'clay'])).rejects.toThrow('ProcessExit');

      expect(runMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenNthCalledWith(1, 'Apply cancelled.');
      expect(exitSpy).toHaveBeenNthCalledWith(1, 1);

      vi.restoreAllMocks();
    });

    it('should skip apply when all actions are NO_OP', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'NO_OP', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(consoleSpy).toHaveBeenCalledWith('No changes. Your infrastructure matches the configuration.');
      expect(confirm).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should run when only an output changes', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'NO_OP', resourceType: 'test', name: 't' }],
        outputs: { greeting: { old: undefined, new: text('hi') } },
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(doneWith({ greeting: text('hi') }));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

      expect(consoleSpy).not.toHaveBeenCalledWith('No changes. Your infrastructure matches the configuration.');
      expect(runMock).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from apply', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(doneWith({ my_output: text('test_value'), another_output: { value: 42, type: types.number } }));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      expect(runMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('my_output = "test_value"'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('another_output = 42'));

      consoleSpy.mockRestore();
    });

    it('should handle unknown action types gracefully', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'UNKNOWN', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          plan: planMock,
          runPlan: runMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      vi.mocked(confirm).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay']);

      // An unknown action type gets no symbol and the fallback tense.
      expect(consoleSpy.mock.calls.flat().join('\n')).toMatch(/ {2}test\.t will be .*destroyed/);
      expect(runMock).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Plan file apply', () => {
    it('should run the saved actions against the saved configuration, without asking again', async () => {
      const planFileContent = JSON.stringify({
        version: PLAN_FILE_VERSION,
        timestamp: '2024-01-01T00:00:00.000Z',
        files: { 'main.clay': 'saved config', 'm/main.clay': 'saved module' },
        serial: 2,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't', planned: {}, after: {} }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({}));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalledWith(expect.objectContaining({ serial: 2, actions: [{ type: 'CREATE', resourceType: 'test', name: 't', planned: {}, after: {} }] }), {
        parallelism: undefined,
        signal: expect.any(AbortSignal),
      });
      expect(InMemoryFiles).toHaveBeenCalledWith({ 'main.clay': 'saved config', 'm/main.clay': 'saved module' });
      expect(confirm).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Applying from saved plan'));

      consoleSpy.mockRestore();
    });

    it('should display outputs when returned from plan apply', async () => {
      const planFileContent = JSON.stringify({
        version: PLAN_FILE_VERSION,
        timestamp: '2024-01-01T00:00:00.000Z',
        files: { 'main.clay': 'saved config', 'm/main.clay': 'saved module' },
        serial: 2,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't', planned: {}, after: {} }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (String(path).includes('plan.json')) return planFileContent;
        return 'config content';
      });

      const runPlanMock = vi.fn(doneWith({ planOutput: text('value') }));

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
          runPlan: runPlanMock,
        } as Partial<Orchestrator> as Orchestrator;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

      expect(runPlanMock).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Outputs:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('planOutput = "value"'));

      consoleSpy.mockRestore();
    });

    it('should reject invalid plan file', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('{ "invalid": true }');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await createApplyCommand().parseAsync(['node', 'clay', 'invalid.json']);

      // The stubbed exit lets the run continue, so the refusal must be reported first.
      expect(consoleSpy.mock.calls[0].join(' ')).toContain('invalid.json is not a plan file');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('Ctrl-C', () => {
    const created = { type: 'CREATE', resourceType: 'test', name: 't' };

    /** Ctrl-C arrives after the action, before the run gives `done` or ends without it. */
    const interruptedRun = async (finishes: boolean) => {
      const planned = { serial: 0, actions: [created], outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} }, dataSources: {}, readAtApply: [] };
      const runMock = vi.fn(async function* () {
        yield { type: 'applied', action: created };
        process.emit('SIGINT');
        if (finishes) yield { type: 'done', outputs: {} };
      });
      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return { registerProvider: vi.fn(), registerProvisioner: vi.fn(), plan: vi.fn().mockResolvedValue(planned), runPlan: runMock } as Partial<Orchestrator> as Orchestrator;
      });

      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const printed: string[] = [];
      const record = (...args: unknown[]) => printed.push(args.join(' '));
      vi.spyOn(console, 'log').mockImplementation(record);
      vi.spyOn(console, 'error').mockImplementation(record);

      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);
      vi.restoreAllMocks();
      return { exit, printed: printed.join('\n') };
    };

    it('ends a run stopped short with 130', async () => {
      const { exit, printed } = await interruptedRun(false);

      expect(printed).toContain('Apply interrupted');
      expect(exit).toHaveBeenCalledWith(130);
    });

    it('reports a run that finished before the interrupt reached it as complete', async () => {
      const { exit, printed } = await interruptedRun(true);

      expect(printed).toContain('Apply complete!');
      expect(printed).not.toContain('Apply interrupted');
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle apply errors gracefully', async () => {
      const planMock = vi.fn().mockResolvedValue({
        serial: 0,
        actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
        outputs: {},
        prevRun: {},
        prior: {},
        schemas: { test: {} },
        dataSources: {},
        readAtApply: [],
      });
      const runMock = vi.fn(async function* () {
        yield { type: 'failed', action: { type: 'CREATE', resourceType: 'test', name: 't' }, error: new Error('disk full') };
      });

      vi.mocked(Orchestrator.create).mockImplementation(function () {
        return {
          registerProvider: vi.fn(),
          registerProvisioner: vi.fn(),
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

  it('names the failures it held when the run then crashes', async () => {
    const runMock = vi.fn(async function* () {
      yield { type: 'failed', action: { type: 'CREATE', resourceType: 'test', name: 't' }, error: new Error('disk full') };
      throw new Error('provider crashed');
    });
    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        registerProvisioner: vi.fn(),
        plan: vi.fn().mockResolvedValue({
          serial: 0,
          actions: [{ type: 'CREATE', resourceType: 'test', name: 't' }],
          outputs: {},
          prevRun: {},
          prior: {},
          schemas: { test: {} },
          dataSources: {},
          readAtApply: [],
        }),
        runPlan: runMock,
      } as Partial<Orchestrator> as Orchestrator;
    });
    vi.mocked(confirm).mockResolvedValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createApplyCommand().parseAsync(['node', 'clay']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed:'), 'test.t: disk full');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Apply failed:'), 'provider crashed');
    const lines = consoleSpy.mock.calls.map((call) => String(call[1]));
    expect(lines.indexOf('test.t: disk full')).toBeLessThan(lines.indexOf('provider crashed'));

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should handle non-Error exceptions gracefully', async () => {
    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        registerProvisioner: vi.fn(),
        plan: vi.fn().mockRejectedValue('String Error'),
      } as Partial<Orchestrator> as Orchestrator;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createApplyCommand().parseAsync(['node', 'clay']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Apply failed:'), 'String Error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

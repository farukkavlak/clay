import { types, UNKNOWN } from '@clay/contracts';
import { Orchestrator } from '@clay/orchestrator';
import fs from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../src/commands/plan';

vi.mock('node:fs/promises');
// The engine is mocked; Address is a plain value type the commands print with, so it stays real.
vi.mock('@clay/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@clay/orchestrator')>('@clay/orchestrator');
  return {
    ...actual,
    Orchestrator: { create: vi.fn() },
    DiskFiles: vi.fn(),
    InMemoryFiles: vi.fn(),
    RecordingFiles: vi.fn(function () {
      return { snapshot: () => ({}) };
    }),
  };
});

describe('CLI: plan command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail if main.clay does not exist', async () => {
    vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error: main.clay not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  // The planner lists every resource, so a plan with nothing to do is all NO_OP, never empty.
  it('should display "No changes" when every action is a NO_OP', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('');

    const planMock = vi
      .fn()
      .mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't1' }], outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });
    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(planMock).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('No changes. Your infrastructure matches the configuration.');

    consoleSpy.mockRestore();
  });

  it('should list a changed output as a change, with no resource to touch', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('');

    const outputs = { gone: { old: 'a', new: undefined }, added: { old: undefined, new: 'b' }, moved: { old: 'a', new: 'b' } };
    const planMock = vi
      .fn()
      .mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't1' }], outputs, prevRun: {}, prior: {}, schemas: { test: {} } });
    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    const printed = consoleSpy.mock.calls.map((call) => String(call[0]));
    expect(printed).not.toContain('No changes. Your infrastructure matches the configuration.');
    expect(printed.some((line) => line.includes('Changes to outputs'))).toBe(true);
    expect(printed.some((line) => line.includes('- gone'))).toBe(true);
    expect(printed.some((line) => line.includes('+ added = "b"'))).toBe(true);
    expect(printed.some((line) => line.includes('~ moved = "a" -> "b"'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('should display planned actions', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

    const actions = [
      { type: 'CREATE', resourceType: 'test', name: 't', attributes: {} },
      { type: 'NO_OP', resourceType: 'test', name: 't2' },
    ];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Clay will perform the following actions:'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('+ test.t will be created'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan: 1 to add, 0 to change, 0 to destroy.'));

    consoleSpy.mockRestore();
  });

  it('should display UPDATE actions with changes', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

    const actions = [
      {
        type: 'UPDATE',
        resourceType: 'test',
        name: 't',
        changes: { path: { old: '/old', new: '/new' } },
      },
    ];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('~ test.t will be updated'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan: 0 to add, 1 to change, 0 to destroy.'));

    consoleSpy.mockRestore();
  });

  // Only a set whose members are known on both sides is shown by member; anything else is shown whole.
  it('shows a set by member only when both sides are known sets', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

    const changes = {
      pending: { old: ['a'], new: UNKNOWN },
      added: { old: undefined, new: ['a'] },
      order: { old: ['a', 'b'], new: ['b', 'a'] },
      names: { old: ['a'], new: ['b'] },
    };
    const schema = {
      pending: { type: types.set(types.dynamic) },
      added: { type: types.set(types.dynamic) },
      order: { type: types.list(types.dynamic) },
      names: { type: types.set(types.dynamic) },
    };
    const planMock = vi.fn().mockResolvedValue({
      serial: 0,
      actions: [{ type: 'UPDATE', resourceType: 'test', name: 't', changes }],
      outputs: {},
      prevRun: {},
      prior: {},
      schemas: { test: schema },
    });
    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return { registerProvider: vi.fn(), plan: planMock } as Partial<Orchestrator> as Orchestrator;
    });
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    const at = printed.indexOf('  ~ test.t will be updated');
    expect(printed.slice(at + 1, at + 7)).toEqual([
      '      pending: ["a"] -> (known after apply)',
      '      added: (none) -> ["a"]',
      '      order: ["a","b"] -> ["b","a"]',
      '      names:',
      '        - "a"',
      '        + "b"',
    ]);
    expect(printed[at + 7]).toBe('\nPlan: 0 to add, 1 to change, 0 to destroy.');
    vi.restoreAllMocks();
  });

  it('should say when a value is not known yet, added or removed', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

    const actions = [
      {
        type: 'UPDATE',
        resourceType: 'test',
        name: 't',
        changes: { path: { old: '/old', new: UNKNOWN }, mode: { old: '0644', new: undefined }, owner: { old: undefined, new: 'me' } },
      },
    ];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('path: "/old" -> (known after apply)'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('mode: "0644" -> (removed)'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('owner: (none) -> "me"'));

    consoleSpy.mockRestore();
  });

  it('should display a REPLACE as one line and count it as an add and a destroy', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('resource "test" "t" {}');

    const actions = [
      {
        type: 'REPLACE',
        resourceType: 'test',
        name: 't',
        changes: { path: { old: '/old', new: '/new' } },
      },
    ];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('-+ test.t will be replaced'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('path: "/old" -> "/new"'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan: 1 to add, 0 to change, 1 to destroy.'));

    consoleSpy.mockRestore();
  });

  it('should display DELETE actions', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('');

    const actions = [{ type: 'DELETE', resourceType: 'test', name: 't' }];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('- test.t will be destroyed'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan: 0 to add, 0 to change, 1 to destroy.'));

    consoleSpy.mockRestore();
  });

  it('should handle planning errors gracefully', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('invalid config');

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: vi.fn().mockRejectedValue(new Error('Parse error')),
      } as Partial<Orchestrator> as Orchestrator;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Planning failed:'), 'Parse error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should handle unknown action types', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('');

    const actions = [{ type: 'UNKNOWN', resourceType: 'test', name: 't' }];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {}, prevRun: {}, prior: {}, schemas: { test: {} } });

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    // A kind the CLI does not know gets a blank where the symbol goes, and the tense it falls back to.
    expect(consoleSpy.mock.calls.flat().join('\n')).toMatch(/ {2}test\.t will be .*destroyed/);

    consoleSpy.mockRestore();
  });

  it('should handle non-Error exceptions gracefully', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('content');

    vi.mocked(Orchestrator.create).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: vi.fn().mockRejectedValue('String Error'),
      } as Partial<Orchestrator> as Orchestrator;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Planning failed:'), 'String Error');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

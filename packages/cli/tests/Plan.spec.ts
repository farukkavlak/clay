import { Orchestrator } from '@clay/orchestrator';
import { UNKNOWN } from '@clay/planner';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../src/commands/plan';

vi.mock('node:fs/promises');
vi.mock('@clay/orchestrator');
vi.mock('chalk', () => ({
  default: {
    blue: vi.fn((m) => m),
    green: vi.fn((m) => m),
    yellow: vi.fn((m) => m),
    red: vi.fn((m) => m),
    bold: vi.fn((m) => m),
  },
}));
vi.mock('@clay/planner', async () => {
  const actual = await vi.importActual('@clay/planner');
  return {
    ...actual,
    serializePlan: vi.fn(() => ({
      version: '5.0',
      timestamp: 'mock-time',
      config: 'mock config',
      modules: {},
      serial: 0,
      actions: [],
      outputs: {},
    })),
  };
});

describe('CLI: plan command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail if main.clay does not exist', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

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

    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't1' }], outputs: {} });
    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions: [{ type: 'NO_OP', resourceType: 'test', name: 't1' }], outputs });
    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
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

    vi.mocked(Orchestrator).mockImplementation(function () {
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
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', 'plan']);

    // Should still display the action even with unknown type
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should save plan to file when -out option is provided', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('content');
    vi.mocked(fs.writeFile).mockResolvedValue(void 0);

    const actions = [{ type: 'CREATE', resourceType: 'test', name: 't', attributes: {} }];
    const planMock = vi.fn().mockResolvedValue({ serial: 0, actions, outputs: {} });

    vi.mocked(Orchestrator).mockImplementation(function () {
      return {
        registerProvider: vi.fn(),
        plan: planMock,
      } as Partial<Orchestrator> as Orchestrator;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);

    expect(fs.writeFile).toHaveBeenCalledWith('plan.json', expect.any(String), 'utf8');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan saved to: plan.json'));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan saved to: plan.json'));

    consoleSpy.mockRestore();
  });

  it('should handle non-Error exceptions gracefully', async () => {
    vi.mocked(fs.access).mockResolvedValue(void 0);
    vi.mocked(fs.readFile).mockResolvedValue('content');

    vi.mocked(Orchestrator).mockImplementation(function () {
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

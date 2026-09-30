import { Orchestrator } from '@clay/orchestrator';
import { DiskFiles } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { changedOutside } from '@clay/planner';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

describe('a plan that reads each resource back first', () => {
  let dir: string;
  let file: string;
  let config: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async () => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const stateFile = () => fs.readFile(path.join(dir, 'clay.state.json'), 'utf8');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-refresh-'));
    file = path.join(dir, 'a.txt');
    config = `resource "local_file" "a" { path = "${file}" content = "applied" }`;
    await apply();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans an update for a file changed by hand, and the apply puts it back', async () => {
    await fs.writeFile(file, 'changed by hand', 'utf8');

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map(({ type, changes }) => ({ type, changes }))).toEqual([{ type: 'UPDATE', changes: { content: { old: 'changed by hand', new: 'applied' } } }]);

    await apply();
    expect(await fs.readFile(file, 'utf8')).toBe('applied');
  });

  it('plans a file deleted by hand to be made again, and the apply makes it', async () => {
    await fs.unlink(file);

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map(({ type }) => type)).toEqual(['CREATE']);

    await apply();
    expect(await fs.readFile(file, 'utf8')).toBe('applied');
  });

  it('carries a resource it finds gone, so the apply can forget it', async () => {
    await fs.unlink(file);

    const kept = await newOrchestrator().plan(config);
    const dropped = await newOrchestrator().plan('');

    expect(changedOutside(kept)).toEqual([{ address: 'local_file.a' }]);
    expect(changedOutside(dropped)).toEqual([{ address: 'local_file.a' }]);
  });

  // The configuration now asks for what was written by hand, so there is nothing to do but record it.
  it('records what it read when an apply has nothing else to do', async () => {
    await fs.writeFile(file, 'by hand', 'utf8');
    config = config.replace('applied', 'by hand');

    const { actions } = await newOrchestrator().plan(config);
    await apply();

    expect(actions.map(({ type }) => type)).toEqual(['NO_OP']);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a'].attributes.content).toBe('by hand');
  });

  it('plans against the state alone when told not to read', async () => {
    await fs.unlink(file);

    const { actions } = await newOrchestrator().plan(config, { refresh: false });

    expect(actions.map(({ type }) => type)).toEqual(['NO_OP']);
  });

  // A plan only looks, so what it read is not written.
  it('leaves the state as it was', async () => {
    const before = await stateFile();
    await fs.unlink(file);

    await newOrchestrator().plan(config);

    expect(await stateFile()).toBe(before);
  });

  it('names the resource it cannot read', async () => {
    await fs.rm(file);
    await fs.mkdir(file);

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message: expect.stringMatching(/^local_file\.a: EISDIR/) as string, cause: { code: 'EISDIR' } });
  });

  describe('from the command line', () => {
    let printed: string[];
    let cwd: string;

    const run = async (command: typeof createPlanCommand, args: string[]) => {
      await command().parseAsync(['node', 'clay', ...args]);
      return printed.join('\n');
    };

    beforeEach(async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
      await fs.unlink(file);
      cwd = process.cwd();
      process.chdir(dir);
      printed = [];
      const record = (...args: unknown[]) => printed.push(args.join(' '));
      vi.spyOn(console, 'log').mockImplementation(record);
      vi.spyOn(console, 'error').mockImplementation(record);
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      process.chdir(cwd);
    });

    it.each([
      ['plan', createPlanCommand],
      ['apply', createApplyCommand],
    ])('%s reads each resource back unless --refresh=false', async (_, command) => {
      expect(await run(command, ['--refresh=false', ...(command === createApplyCommand ? ['-y'] : [])])).toContain('No changes.');
      expect(await run(command, command === createApplyCommand ? ['-y'] : [])).toContain('local_file.a will be created');
    });

    it('shows a resource found gone, and an apply of the saved plan forgets it', async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), '', 'utf8');

      const planned = await run(createPlanCommand, ['--out', 'plan.json']);
      expect(planned).toContain('local_file.a was deleted outside Clay');
      expect(planned).toContain('An apply would only update the state.');

      expect(await run(createApplyCommand, ['plan.json'])).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed, 1 forgotten.');

      const state = await new LocalBackend(dir).read();
      expect(state.resources).toEqual({});
    });

    it('forgets a resource found gone on an apply that plans as it goes', async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), '', 'utf8');

      expect(await run(createApplyCommand, ['-y'])).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed, 1 forgotten.');
      const state = await new LocalBackend(dir).read();
      expect(state.resources).toEqual({});
    });

    // It is made again, so the state keeps it.
    it('does not count a resource found gone as forgotten when the apply makes it again', async () => {
      expect(await run(createApplyCommand, ['-y'])).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.');
    });

    // Nothing is left to do but record what was read, which is still work for an apply.
    it('applies a plan whose only change is a value changed outside Clay', async () => {
      await fs.writeFile(file, 'by hand', 'utf8');
      await fs.writeFile(path.join(dir, 'main.clay'), config.replace('applied', 'by hand'), 'utf8');

      const applied = await run(createApplyCommand, ['-y']);

      expect(applied).toContain('An apply would only update the state.');
      expect(applied).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.');
      const state = await new LocalBackend(dir).read();
      expect(state.resources['local_file.a'].attributes.content).toBe('by hand');
    });

    it('says nothing changed outside Clay when nothing did', async () => {
      await fs.writeFile(file, 'applied', 'utf8');
      await fs.writeFile(path.join(dir, 'main.clay'), config.replace('applied', 'new'), 'utf8');

      const planned = await run(createPlanCommand, []);

      expect(planned).toContain('local_file.a will be updated');
      expect(planned).not.toContain('Changed outside Clay');
    });

    // The action is filed where count moves it, but the state keeps it, so it is not forgotten.
    it('does not count a resource changed by hand and moved by count as forgotten', async () => {
      await fs.writeFile(file, 'by hand', 'utf8');
      await fs.writeFile(path.join(dir, 'main.clay'), config.replace('{', '{ count = 1').replace('applied', 'by hand'), 'utf8');

      const applied = await run(createApplyCommand, ['-y']);

      expect(applied).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed, 1 moved.');
      const state = await new LocalBackend(dir).read();
      expect(Object.keys(state.resources)).toEqual(['local_file.a[0]']);
    });

    it('shows a value changed outside Clay', async () => {
      await fs.writeFile(file, 'by hand', 'utf8');

      const planned = await run(createPlanCommand, []);

      expect(planned).toContain('local_file.a was changed outside Clay');
      expect(planned).toContain('content: "applied" -> "by hand"');
    });

    it('refuses a --refresh that is neither true nor false', async () => {
      const command = createPlanCommand()
        .exitOverride()
        .configureOutput({ writeErr: () => {} });

      await expect(command.parseAsync(['node', 'clay', '--refresh=maybe'])).rejects.toThrow("option '--refresh <bool>' argument 'maybe' is invalid. --refresh is true or false");
    });

    it('refuses --refresh on a saved plan, which is applied as it was made', async () => {
      await run(createPlanCommand, ['--out', 'plan.json']);

      expect(await run(createApplyCommand, ['plan.json', '--refresh=false'])).toContain('--refresh is for a plan: a saved plan is applied as it was made');
      expect(await fs.readFile(file, 'utf8').catch(() => 'not made')).toBe('not made');
    });
  });
});

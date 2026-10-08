import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

const moduleConfig = (text: string) => `output "text" { value = "${text}" }`;

const calls = (keys: string) => `module "m" {\n  for_each = ${keys}\n  source = "./m"\n}`;

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

describe('a plan saved to a file', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const fileConfig = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
  `;

  const chained = () => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'b.txt')}"
      content = "\${local_file.a.content}"
    }
  `;

  const withOutput = (content: string) => `${fileConfig(content)}\noutput "text" { value = local_file.a.content }`;
  const written = async (config: string) => serializePlan(await newOrchestrator().plan(config), config, {});
  const save = async (config: string) => parsePlanFile(await written(config), 'plan.json');

  const runs = (saved: Awaited<ReturnType<typeof save>>, config: string) => drain(newOrchestrator().runPlan(saved, config));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-saved-plan-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // apply reads the current directory, so the command runs from the temp one.
  it('is applied by the CLI without reading the configuration on disk', async () => {
    await fs.writeFile(path.join(dir, 'plan.json'), await written(fileConfig('planned')), 'utf8');
    await fs.writeFile(path.join(dir, 'main.clay'), fileConfig('changed'), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The command exits the process on failure, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });

  it('reads an index and a key in a reference back from the file', async () => {
    const config = `
      variable "m" { default = { k = "there" } }
      resource "local_file" "a" {
        count = 2
        path = "\${path.module}/a\${count.index}.txt"
        content = "hello \${count.index}"
      }
      resource "local_file" "b" {
        path = "\${path.module}/b.txt"
        content = "\${local_file.a[1].content} \${var.m["k"]}"
      }
    `;
    await fs.writeFile(path.join(dir, 'plan.json'), await written(config), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('hello 1 there');
  });

  it('reads the line a broken configuration was written on out of the plan, not off the disk', async () => {
    const saved = { ...JSON.parse(await written(fileConfig('planned'))), config: 'resource "local_file" {' };
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(saved), 'utf8');

    const printed: string[] = [];
    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readdir(dir)).toEqual(['plan.json']);
    expect(printed.join('\n')).toContain('\n  1: resource "local_file" {\n                           ^');
  });

  // Uses the real `serializePlan` and `parsePlanFile`; a stub would only agree with itself.
  it('writes a file the apply side can read back, and says where it put it', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), fileConfig('planned'), 'utf8');

    const printed: string[] = [];
    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    const written = await fs.readFile(path.join(dir, 'plan.json'), 'utf8');

    expect(printed.join('\n')).toContain('Plan saved to: plan.json');
    expect(parsePlanFile(written, 'plan.json').actions.map((action) => action.name)).toEqual(['a']);
  });

  // The file must carry an unknown output, though UNKNOWN has no JSON form.
  it('shows a value not known yet as one when the plan is applied from its file', async () => {
    const config = `
      resource "random_string" "a" { length = 4 }
      output "id" { value = "\${random_string.a.id}" }
    `;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

    const printed: string[] = [];
    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
      printed.length = 0;
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(printed.join('\n')).toContain('Applying from saved plan');
    expect(printed.join('\n')).toContain('id = (known after apply)');
  });

  // A relative path resolves where the apply runs, which the plan cannot know.
  it('is applied from another directory with a file at a relative path', async () => {
    const [planned, applied] = [path.join(dir, 'planned'), path.join(dir, 'applied')];
    await fs.mkdir(planned);
    await fs.mkdir(applied);
    await fs.writeFile(path.join(planned, 'main.clay'), 'resource "local_file" "a" { path = "c.txt" content = "hi" }', 'utf8');

    const cwd = process.cwd();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      process.chdir(planned);
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
      process.chdir(applied);
      await createApplyCommand().parseAsync(['node', 'clay', path.join(planned, 'plan.json')]);
      expect(failed).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(applied, 'c.txt'), 'utf8')).toBe('hi');
  });

  it('carries its modules, so a module edited or removed later changes nothing', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), moduleConfig('planned'), 'utf8');
    const fromModule = fileConfig(`\${module.m.text}`);
    await fs.writeFile(path.join(dir, 'main.clay'), `module "m" { source = "./m" }\n${fromModule}`, 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
      await fs.rm(path.join(dir, 'm'), { recursive: true });
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    const saved = JSON.parse(String(await fs.readFile(path.join(dir, 'plan.json'))));
    expect(saved.modules).toEqual({ 'm/main.clay': moduleConfig('planned') });
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });

  it('stops when it names a resource the configuration no longer declares', async () => {
    const saved = await save(chained());
    const onlyB = saved.actions.filter((action) => action.name === 'b');

    await expect(drain(newOrchestrator().runPlan({ ...saved, actions: onlyB }, fileConfig('hello')))).rejects.toThrow(
      'The plan has "local_file.b", which the configuration does not declare'
    );
  });

  // The block exists; only its module instance is gone from the configuration.
  it('stops when it names an instance of a module the configuration does not make', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), fileConfig('hello'), 'utf8');
    const config = 'module "m" { source = "./m" }';
    const saved = await save(config);
    const elsewhere = saved.actions.map((action) => ({ ...action, modulePath: [{ name: 'm', key: 0 }] }));

    await expect(drain(newOrchestrator().runPlan({ ...saved, actions: elsewhere }, config))).rejects.toThrow(
      'The plan has "module.m[0].local_file.a", which the configuration does not declare'
    );
    await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  // Planned again, `b` would be made. `a` runs first, as the plan says.
  it('stops at a resource the configuration declares and the plan has no action for', async () => {
    const saved = await save(fileConfig('hello'));

    await expect(drain(newOrchestrator().runPlan(saved, chained()))).rejects.toMatchObject({
      message: 'The plan has no action for local_file.b, which the configuration declares',
      block: 'resource "local_file" "b"',
      position: { line: 6, column: 5 },
    });
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow();
  });

  it('stops at an instance of a module the configuration makes and the plan has no action for', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "a" { path = "${path.join(dir, 'm')}\${path.module}.txt" content = "x" }`, 'utf8');
    const saved = await save(calls('["x"]'));

    await expect(drain(newOrchestrator().runPlan(saved, calls('["x", "y"]')))).rejects.toMatchObject({
      message: 'The plan has no action for module.m["y"].local_file.a, which the configuration declares',
      module: 'module.m["y"]',
    });
  });

  it('stops at an instance its count gives and the plan has no action for, before any instance runs', async () => {
    const config = `resource "local_file" "f" {\n  count = 2\n  path = "${path.join(dir, 'f')}\${count.index}.txt"\n  content = "x"\n}`;
    const saved = await save(config);
    const first = saved.actions.filter((action) => action.key === 0);

    await expect(drain(newOrchestrator().runPlan({ ...saved, actions: first }, config))).rejects.toThrow(
      'The plan has no action for local_file.f[1], which the configuration declares'
    );
    await expect(fs.access(path.join(dir, 'f0.txt'))).rejects.toThrow();
  });

  describe('whose outputs are not the ones the configuration declares', () => {
    it('stops before anything runs at an output it shows and the configuration does not declare', async () => {
      const saved = await save(withOutput('hello'));

      await expect(runs(saved, fileConfig('hello'))).rejects.toThrow('The plan has output "text", which the configuration does not declare');
      await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
    });

    it('stops before anything runs at an output the configuration declares and it never showed', async () => {
      const saved = await save(fileConfig('hello'));

      await expect(runs(saved, withOutput('hello'))).rejects.toMatchObject({
        message: 'The plan has no output "text", which the configuration declares',
        block: 'output "text"',
        position: { line: 7, column: 1 },
      });
      await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
    });

    it('stops at an output it takes away and the configuration still declares', async () => {
      await drain(start(newOrchestrator(), withOutput('hello')));
      const saved = await save(fileConfig('hello'));

      await expect(runs(saved, withOutput('hello'))).rejects.toThrow('The plan has no output "text", which the configuration declares');
    });

    it('runs with an output that stays as it is, which it does not show', async () => {
      await drain(start(newOrchestrator(), withOutput('hello')));
      const saved = await save(withOutput('hello'));

      await runs(saved, withOutput('hello'));

      expect(saved.outputs).toEqual({});
      const state = await new LocalBackend(dir).read();
      expect(state.outputs?.text.value).toBe('hello');
    });
  });

  // A plan file carries its own names, so the apply checks them again.
  it('stops on a name the schema does not have that the plan file carries, before the provider is sent it', async () => {
    const saved = await save(fileConfig('hello'));
    const misspelled = saved.actions.map((action) => ({
      ...action,
      attributes: { ...action.attributes, contnet: action.attributes!.content },
      planned: { ...action.planned, contnet: 'hello' },
    }));

    await expect(drain(newOrchestrator().runPlan({ ...saved, actions: misspelled }, saved.config))).rejects.toThrow('local_file has no attribute "contnet"');
    await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  it('is refused once another run has written the state', async () => {
    const saved = await save(fileConfig('planned'));

    await drain(start(newOrchestrator(), fileConfig('changed')));

    await expect(drain(newOrchestrator().runPlan(saved, saved.config))).rejects.toThrow('The state has changed since the plan was made');
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('changed');
  });
});

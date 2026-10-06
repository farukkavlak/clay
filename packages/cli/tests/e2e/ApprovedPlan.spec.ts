import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { start } from './start';

vi.mock('node:readline/promises');

const counted = (count: number) => `
  resource "local_file" "f" {
    count = ${count}
    path = "\${path.module}/f\${count.index}.txt"
    content = "x"
  }
  output "n" { value = ${count} }
`;

// apply reads the current directory, so the command runs from the temp one.
describe('the plan apply showed', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const fileConfig = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
  `;

  const applyElsewhere = async (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-approved-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused when the state changes while the question is open', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), fileConfig('mine'), 'utf8');
    // Another run writes the state before the answer comes.
    const question = vi.fn(async () => {
      await applyElsewhere(fileConfig('theirs'));
      return 'yes';
    });
    vi.mocked(readline.createInterface).mockReturnValue(Object.assign(new EventTarget(), { question, close: vi.fn() }) as unknown as readline.Interface);

    await createApplyCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('The state has changed since the plan was made. Plan again.');
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('theirs');
  });

  it('runs the module files it planned when one changes while the question is open', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'main.clay'), 'module "m" { source = "./m" }\noutput "n" { value = module.m.n }', 'utf8');
    await fs.writeFile(path.join(dir, 'm/main.clay'), counted(2), 'utf8');
    const question = vi.fn(async () => {
      await fs.writeFile(path.join(dir, 'm/main.clay'), counted(3), 'utf8');
      return 'yes';
    });
    vi.mocked(readline.createInterface).mockReturnValue(Object.assign(new EventTarget(), { question, close: vi.fn() }) as unknown as readline.Interface);

    await createApplyCommand().parseAsync(['node', 'clay']);

    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { outputs: { n: { value: number } } };
    expect(state.outputs.n.value).toBe(2);
  });

  // The id is not known at plan, so stepping into it fails only once the run resolves the output.
  it('shows the line it planned when a run error points into a file changed while the question is open', async () => {
    const config = 'resource "null_resource" "n" {}\noutput "x" { value = null_resource.n.id.foo }';
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    const question = vi.fn(async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), `resource "null_resource" "m" {}\n${config}`, 'utf8');
      return 'yes';
    });
    vi.mocked(readline.createInterface).mockReturnValue(Object.assign(new EventTarget(), { question, close: vi.fn() }) as unknown as readline.Interface);

    await createApplyCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('2: output "x" { value = null_resource.n.id.foo }');
  });
});

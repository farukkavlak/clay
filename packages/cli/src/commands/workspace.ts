import { emptyState, State } from '@clay/contracts';
import { ConfigFiles, DiskFiles, RecordingFiles } from '@clay/orchestrator';
import {
  checkWorkspaceName,
  currentWorkspace,
  DEFAULT_WORKSPACE,
  givenWorkspace,
  NamedWorkspace,
  namedWorkspace,
  selectedWorkspace,
  selectWorkspace,
  StateManager,
  workspaceBackend,
} from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { lockTimeoutOption, lockWait } from '../lockTimeoutOption';
import { releasedAfter } from '../released';
import { checkedBackend } from '../stateFile';

const GIVEN = 'the command line';

/** Runs `work` on the configuration in this directory, and exits 1 with what went wrong. */
function inThisDirectory(failure: string, work: (cwd: string, files: ConfigFiles) => Promise<number>): () => Promise<void> {
  return async () => {
    const cwd = process.cwd();
    const files = new RecordingFiles(new DiskFiles(cwd));
    let code: number;
    try {
      code = await work(cwd, files);
    } catch (error) {
      console.error(styleText('red', failure), describeError(error, files));
      code = 1;
    }
    if (code !== 0) process.exit(code);
  };
}

/** Selects a new workspace, unless `CLAY_WORKSPACE` gave it: that holds for one command, so it leaves the selection as it was. */
async function announceNew(cwd: string, name: string, given: string | undefined): Promise<void> {
  if (given !== undefined) {
    console.log(styleText('green', `✓ Created workspace "${name}"`));
    return;
  }

  await selectWorkspace(cwd, name);
  console.log(styleText('green', `✓ Created and selected workspace "${name}"`));
}

/** Under the lock of the new workspace, so of two made at once with one name, one is refused. */
async function newWorkspace(cwd: string, files: ConfigFiles, name: string, lockTimeout?: number): Promise<number> {
  const given = givenWorkspace(process.env);
  if (given !== undefined && given !== name) throw new Error(`CLAY_WORKSPACE names workspace "${given}"; unset it, or set it to "${name}", to make "${name}"`);
  if (name === DEFAULT_WORKSPACE) throw new Error(`Workspace "${name}" exists already`);

  const backend = checkedBackend(cwd, files);
  await backend.check();
  const named = namedWorkspace(backend, name);
  await named.prepare?.();
  const manager = new StateManager(named, lockWait(lockTimeout));

  return releasedAfter(manager, async () => {
    await stoppedAtOnce([manager], () => manager.lock('workspace new'));
    if (!(await manager.writeIfAbsent(emptyState()))) throw new Error(`Workspace "${name}" exists already`);

    await announceNew(cwd, name, given);
    return 0;
  });
}

async function select(cwd: string, files: ConfigFiles, name: string): Promise<number> {
  if (givenWorkspace(process.env) !== undefined) throw new Error('CLAY_WORKSPACE chooses the workspace, so selecting one would change nothing; unset it first');

  await workspaceBackend(checkedBackend(cwd, files), name);
  await selectWorkspace(cwd, name);
  console.log(styleText('green', `✓ Selected workspace "${name}"`));
  return 0;
}

const missing = (name: string) => new Error(`Workspace "${name}" does not exist`);

const holdsObjects = ({ resources, deposed }: State) => Object.keys(resources).length > 0 || Object.keys(deposed ?? {}).length > 0;

async function deletedUnderLock(named: NamedWorkspace, manager: StateManager, name: string, force: boolean): Promise<number> {
  await stoppedAtOnce([manager], () => manager.lock('workspace delete'));
  if (!force && holdsObjects(await manager.read()))
    throw new Error(
      `Workspace "${name}" still has resources in its state; destroy them with \`clay destroy\` in that workspace first, or delete it with --force, which forgets them and leaves them in place`
    );

  await named.remove();
  console.log(styleText('green', `✓ Deleted workspace "${name}"`));
  return 0;
}

async function deleteWorkspace(cwd: string, files: ConfigFiles, name: string, options: { force?: boolean; lockTimeout?: number }): Promise<number> {
  // Delete does not run on this workspace, but a wrong name is still refused.
  givenWorkspace(process.env);
  if (name === DEFAULT_WORKSPACE) throw new Error(`Workspace "${name}" always exists, and cannot be deleted`);
  if (name === selectedWorkspace(cwd)) throw new Error(`Workspace "${name}" is selected; select another one before deleting it`);

  const named = namedWorkspace(checkedBackend(cwd, files), name);
  if (!(await named.exists())) throw missing(name);
  const manager = new StateManager(named, lockWait(options.lockTimeout));

  const code = await releasedAfter(manager, () => deletedUnderLock(named, manager, name, options.force ?? false));
  await named.prune();
  return code;
}

async function list(cwd: string, files: ConfigFiles): Promise<number> {
  const backend = checkedBackend(cwd, files);
  const selected = currentWorkspace(cwd, process.env);
  const names = backend.listWorkspaces ? await backend.listWorkspaces() : [DEFAULT_WORKSPACE];
  for (const name of names) console.log(name === selected ? `* ${name}` : `  ${name}`);
  return 0;
}

export function createWorkspaceCommand(): Command {
  const command = new Command('workspace').description('Keep copies of this configuration, each with a state of its own');

  command
    .command('new')
    .description('Make a workspace with an empty state, and select it')
    .argument('<name>', 'The name of the workspace')
    .addOption(lockTimeoutOption())
    .action((name: string, options: { lockTimeout?: number }) =>
      inThisDirectory('Failed to make the workspace:', (cwd, files) => newWorkspace(cwd, files, checkWorkspaceName(name, GIVEN), options.lockTimeout))()
    );

  command
    .command('select')
    .description('Run the commands that follow on a workspace')
    .argument('<name>', 'The name of the workspace')
    .action((name: string) => inThisDirectory('Failed to select the workspace:', (cwd, files) => select(cwd, files, checkWorkspaceName(name, GIVEN)))());

  command
    .command('show')
    .description('Print the workspace commands run on')
    .action(
      inThisDirectory('Failed to read the workspace:', async (cwd) => {
        console.log(currentWorkspace(cwd, process.env));
        return 0;
      })
    );

  command
    .command('delete')
    .description('Delete a workspace that has no resources in its state')
    .argument('<name>', 'The name of the workspace')
    .option('-f, --force', 'Delete it with its resources still in its state, which then no run manages')
    .addOption(lockTimeoutOption())
    .action((name: string, options: { force?: boolean; lockTimeout?: number }) =>
      inThisDirectory('Failed to delete the workspace:', (cwd, files) => deleteWorkspace(cwd, files, checkWorkspaceName(name, GIVEN), options))()
    );

  command.command('list').description('List the workspaces, marking the one commands run on').action(inThisDirectory('Failed to list the workspaces:', list));

  return command;
}

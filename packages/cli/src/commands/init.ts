import { emptyState } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { adoptBackend, Approve, DEFAULT_WORKSPACE, Moved, MovedWorkspace, rememberedBackend, StateBackend, StateManager, Stoppable } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { lockTimeoutOption, lockWait } from '../lockTimeoutOption';
import { releasedAfter, reportLockLeft } from '../released';
import { namedBackend } from '../stateFile';

function movedLine({ name, copied }: MovedWorkspace, from: string, to: string): string {
  const state = name === DEFAULT_WORKSPACE ? 'the state' : `the state of workspace "${name}"`;
  if (copied) return `✓ Moved ${state} in "${from}" to "${to}"; the old one is left as it was`;

  return name === DEFAULT_WORKSPACE ? `✓ Took "${to}", which holds the same state as "${from}"` : `✓ Took ${state} in "${to}", which is the same as in "${from}"`;
}

function reportMoved({ from, workspaces }: Moved, to: StateBackend): void {
  for (const workspace of workspaces) console.log(styleText('green', movedLine(workspace, from.where, to.choice.where)));
}

interface InitOptions {
  yes: boolean;
  lockTimeout?: number;
}

/** Ctrl-C while a lock is awaited, or at the question, stops every manager and releases what they hold. */
async function initialize(backend: StateBackend, cwd: string, options: InitOptions): Promise<number> {
  await backend.check();

  const wait = lockWait(options.lockTimeout);
  const stateManager = new StateManager(backend, wait);
  const managers = [stateManager];
  const manage = (locked: StateBackend) => {
    const manager = new StateManager(locked, wait);
    managers.push(manager);
    return manager;
  };
  const previous = { backend: rememberedBackend(cwd, process.env), manage };
  const stoppable: Stoppable = (step) => stoppedAtOnce(managers, step);
  const approve: Approve = options.yes ? async () => true : (question) => stoppable(() => confirm(question));

  return releasedAfter(stateManager, async () => {
    await stoppable(() => stateManager.lock('init'));
    const { moved, locksLeft = [] } = await adoptBackend(backend, previous, cwd, approve, stoppable);
    if (moved) reportMoved(moved, backend);
    if (!moved?.workspaces.some(({ name }) => name === DEFAULT_WORKSPACE)) {
      const wroteState = await stateManager.writeIfAbsent(emptyState());
      console.log(styleText('green', wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));
    }
    console.log(styleText(['bold', 'green'], '\nClay initialized successfully! 🚀'));
    for (const left of locksLeft) reportLockLeft(left);

    return locksLeft.length === 0 ? 0 : 1;
  });
}

export function createInitCommand() {
  return new Command('init')
    .description('Initialize Clay in this directory')
    .option('-y, --yes', 'Move a state to the backend the configuration names without asking')
    .addOption(lockTimeoutOption())
    .action(async (options: { yes?: boolean; lockTimeout?: number }) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      console.log(styleText('blue', 'Initializing Clay in this directory...'));

      let code: number;
      try {
        code = await initialize(namedBackend(cwd, files), cwd, { yes: options.yes ?? false, lockTimeout: options.lockTimeout });
      } catch (error: unknown) {
        console.error(styleText('red', 'Failed to initialize Clay in this directory:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

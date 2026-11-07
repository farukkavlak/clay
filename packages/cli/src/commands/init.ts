import { emptyState } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { adoptBackend, Approve, Moved, rememberedBackend, StateBackend, StateManager, Stoppable } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { lockTimeoutOption, lockWait } from '../lockTimeoutOption';
import { releasedAfter, reportLockLeft } from '../released';
import { namedBackend } from '../stateFile';

function reportMoved({ from, copied }: Moved, to: StateBackend): void {
  const line = copied
    ? `✓ Moved the state in "${from.where}" to "${to.choice.where}"; the old one is left as it was`
    : `✓ Took "${to.choice.where}", which holds the same state as "${from.where}"`;
  console.log(styleText('green', line));
}

interface InitOptions {
  yes: boolean;
  lockTimeout?: number;
}

/** Ctrl-C while either lock is awaited, or at the question, stops both managers and releases what they hold. */
async function initialize(backend: StateBackend, cwd: string, options: InitOptions): Promise<number> {
  await backend.check();

  const stateManager = new StateManager(backend, lockWait(options.lockTimeout));
  const before = rememberedBackend(cwd, process.env);
  const previous = { backend: before, manager: new StateManager(before, lockWait(options.lockTimeout)) };
  const stoppable: Stoppable = (step) => stoppedAtOnce([stateManager, previous.manager], step);
  const approve: Approve = options.yes ? async () => true : (question) => stoppable(() => confirm(question));

  return releasedAfter(stateManager, async () => {
    await stoppable(() => stateManager.lock('init'));
    const { moved, lockLeft } = await adoptBackend(backend, previous, cwd, approve, stoppable);
    if (moved) reportMoved(moved, backend);
    else {
      const wroteState = await stateManager.writeIfAbsent(emptyState());
      console.log(styleText('green', wroteState ? '✓ Created an empty state' : '✓ Kept the state already here'));
    }
    console.log(styleText(['bold', 'green'], '\nClay initialized successfully! 🚀'));
    if (!lockLeft) return 0;

    reportLockLeft(lockLeft);
    return 1;
  });
}

export function createInitCommand() {
  return new Command('init')
    .description('Initialize a new Clay workspace')
    .option('-y, --yes', 'Move a state to the backend the configuration names without asking')
    .addOption(lockTimeoutOption())
    .action(async (options: { yes?: boolean; lockTimeout?: number }) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      console.log(styleText('blue', 'Initializing Clay workspace...'));

      let code: number;
      try {
        code = await initialize(namedBackend(cwd, files), cwd, { yes: options.yes ?? false, lockTimeout: options.lockTimeout });
      } catch (error: unknown) {
        console.error(styleText('red', 'Failed to initialize workspace:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

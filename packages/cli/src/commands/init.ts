import { emptyState } from '@clay/contracts';
import { DiskFiles, RecordingFiles } from '@clay/orchestrator';
import { adoptBackend, Approve, Moved, rememberedBackend, StateBackend, StateManager } from '@clay/state';
import { Command } from 'commander';
import { styleText } from 'node:util';

import { confirm } from '../confirm';
import { describeError } from '../describeError';
import { stoppedAtOnce } from '../interruptible';
import { releasedAfter, reportLockLeft } from '../released';
import { namedBackend } from '../stateFile';

function reportMoved({ from, copied }: Moved, to: StateBackend): void {
  const line = copied
    ? `✓ Moved the state in "${from.where}" to "${to.choice.where}"; the old one is left as it was`
    : `✓ Took "${to.choice.where}", which holds the same state as "${from.where}"`;
  console.log(styleText('green', line));
}

/** The question is asked under both locks, so Ctrl-C at it releases both. */
async function initialize(backend: StateBackend, cwd: string, yes: boolean): Promise<number> {
  await backend.check();

  const stateManager = new StateManager(backend);
  const before = rememberedBackend(cwd, process.env);
  const previous = { backend: before, manager: new StateManager(before) };
  const approve: Approve = yes ? async () => true : (question) => stoppedAtOnce([stateManager, previous.manager], () => confirm(question));

  return releasedAfter(stateManager, async () => {
    await stateManager.lock('init');
    const { moved, lockLeft } = await adoptBackend(backend, previous, cwd, approve);
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
    .action(async (options: { yes?: boolean }) => {
      const cwd = process.cwd();
      const files = new RecordingFiles(new DiskFiles(cwd));

      console.log(styleText('blue', 'Initializing Clay workspace...'));

      let code: number;
      try {
        code = await initialize(namedBackend(cwd, files), cwd, options.yes ?? false);
      } catch (error: unknown) {
        console.error(styleText('red', 'Failed to initialize workspace:'), describeError(error, files));
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
}

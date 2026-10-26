import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, State } from '@clay/contracts';

import { StateBackend } from '../StateBackend';
import { Journal, parseState, serializeState } from '../stateFile';

export class LocalBackend implements StateBackend {
  private filePath: string;
  private lockFilePath: string;
  private journalPath: string;
  private backedUp = false;

  constructor(workingDir: string, filename: string = 'clay.state.json') {
    this.filePath = path.join(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
    this.journalPath = `${this.filePath}.journal`;
  }

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<State> {
    try {
      const content = await fs.readFile(this.filePath);
      return parseState(content.toString('utf8'), this.filePath, await this.readJournal());
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') return emptyState();

      throw error;
    }
  }

  async write(state: State): Promise<void> {
    if (!this.backedUp) await this.backUp();

    // Rename is atomic, so a run killed mid-write leaves the old state whole.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, serializeState(state), 'utf8');
    await fs.rename(tmpPath, this.filePath);
    // Its lines are in the state now; a run stopped before this point leaves lines of an older serial, which are skipped.
    await fs.rm(this.journalPath, { force: true });
  }

  /** As it is read, so what a stopped run left in the journal is in the backup too. */
  private async copyBefore(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal) {
      await fs.copyFile(this.filePath, `${this.filePath}.bak`);
      return;
    }

    const content = await fs.readFile(this.filePath, 'utf8');
    await fs.writeFile(`${this.filePath}.bak`, serializeState(parseState(content, this.filePath, journal)), 'utf8');
  }

  async append(line: string): Promise<void> {
    await fs.appendFile(this.journalPath, line, 'utf8');
  }

  private async readJournal(): Promise<Journal | undefined> {
    try {
      return { content: await fs.readFile(this.journalPath, 'utf8'), source: this.journalPath };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;

      throw error;
    }
  }

  /** Once per lock, so the backup is the state from before the run. */
  private async backUp(): Promise<void> {
    try {
      await this.copyBefore();
    } catch (error) {
      // No state file yet means nothing to back up; any other failure would leave no backup.
      const { code, message } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT') throw new Error(`Could not back up ${this.filePath} to ${this.filePath}.bak (${code ?? message}); the state was not written`, { cause: error });
    }

    this.backedUp = true;
  }

  /** The `wx` flag makes check and write one step, so nothing can slip in between. */
  async writeIfAbsent(state: State): Promise<boolean> {
    try {
      await fs.writeFile(this.filePath, serializeState(state), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;

      throw error;
    }
  }

  async lock(): Promise<void> {
    try {
      await fs.writeFile(this.lockFilePath, String(Date.now()), { flag: 'wx' });
      this.backedUp = false;
    } catch (error) {
      if ((error as { code: string }).code === 'EEXIST') throw new Error(`State is locked by another run. If that run is gone, remove ${this.lockFilePath}`);

      throw error;
    }
  }

  async unlock(): Promise<void> {
    try {
      await fs.unlink(this.lockFilePath);
    } catch (error) {
      if ((error as { code: string }).code !== 'ENOENT') throw error;

      // Unlocking twice is not an error.
    }
  }
}

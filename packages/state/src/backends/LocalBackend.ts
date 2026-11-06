import { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, State } from '@clay/contracts';

import { LockInfo, lockInfoFrom, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { Journal, parseState, serializeState } from '../stateFile';

/** Undefined where nothing is there, or a file stands in the way of the path. */
async function statOf(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;

    throw error;
  }
}

export class LocalBackend implements StateBackend {
  readonly choice: BackendChoice;
  private filePath: string;
  private lockFilePath: string;
  private journalPath: string;
  private backedUp = false;

  constructor(workingDir: string, filename: string = 'clay.state.json') {
    this.filePath = path.resolve(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
    this.journalPath = `${this.filePath}.journal`;
    this.choice = { type: 'local', where: path.relative(workingDir, this.filePath) };
  }

  get location(): string {
    return this.filePath;
  }

  async check(): Promise<void> {
    const file = await statOf(this.filePath);
    if (file?.isDirectory()) throw new Error(`${this.filePath} is a directory, and the state is a file`);

    const parent = path.dirname(this.filePath);
    const holder = await statOf(parent);
    if (!holder?.isDirectory()) throw new Error(`${parent} is not a directory, so the state cannot be kept in it; Clay makes none`);
  }

  /** Only ENOENT means missing; any other error is thrown. */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;

      throw error;
    }
  }

  /** A journal counts: a state moved without it would lose what a stopped run recorded. */
  async holdsAnything(): Promise<boolean> {
    return (await this.exists()) || (await statOf(this.journalPath)) !== undefined;
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

  async lock(info: LockInfo): Promise<void> {
    try {
      await fs.writeFile(this.lockFilePath, JSON.stringify(info), { encoding: 'utf8', flag: 'wx' });
      this.backedUp = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      throw new StateLocked(await this.holder(), `remove ${this.lockFilePath}`);
    }
  }

  /** A run killed between making the lock file and filling it leaves it empty; one that has just unlocked leaves none. */
  private async holder(): Promise<LockInfo | undefined> {
    try {
      return lockInfoFrom(await fs.readFile(this.lockFilePath, 'utf8'));
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') return undefined;

      throw new Error(`State is locked, and its lock ${this.lockFilePath} cannot be read (${code ?? message})`, { cause: error });
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

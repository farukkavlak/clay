import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, State } from '@clay/contracts';

import { StateBackend } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';

export class LocalBackend implements StateBackend {
  private filePath: string;
  private lockFilePath: string;

  constructor(workingDir: string, filename: string = 'clay.state.json') {
    this.filePath = path.join(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
  }

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<State> {
    try {
      const content = await fs.readFile(this.filePath);
      return parseState(content.toString('utf8'), this.filePath);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') return emptyState();

      throw error;
    }
  }

  async write(state: State): Promise<void> {
    try {
      await fs.copyFile(this.filePath, `${this.filePath}.bak`);
    } catch (error) {
      // No state file yet means nothing to back up; any other failure would leave no backup.
      const { code, message } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT') throw new Error(`Could not back up ${this.filePath} to ${this.filePath}.bak (${code ?? message}); the state was not written`, { cause: error });
    }

    // Rename is atomic, so a run killed mid-write leaves the old state whole.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, serializeState(state), 'utf8');
    await fs.rename(tmpPath, this.filePath);
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

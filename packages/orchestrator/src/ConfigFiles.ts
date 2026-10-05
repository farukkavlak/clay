import * as fs from 'node:fs';
import path from 'node:path';

/** Files are named by path relative to the root configuration, with forward slashes. */
export interface ConfigFiles {
  /** Undefined when the file does not exist. */
  read(file: string): string | undefined;
}

export class DiskFiles implements ConfigFiles {
  constructor(private rootDir: string) {}

  read(file: string): string | undefined {
    try {
      return fs.readFileSync(path.resolve(this.rootDir, file), 'utf8');
    } catch (error) {
      // Only ENOENT means missing; any other error is thrown.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;

      throw error;
    }
  }
}

export class InMemoryFiles implements ConfigFiles {
  constructor(private files: Record<string, string>) {}

  read(file: string): string | undefined {
    return this.files[file];
  }
}

/** Records every file read, so a saved plan can carry its configuration. */
export class RecordingFiles implements ConfigFiles {
  private files: Record<string, string> = {};

  constructor(private source: ConfigFiles) {}

  read(file: string): string | undefined {
    const content = this.source.read(file);
    if (content !== undefined) this.files[file] = content;

    return content;
  }

  snapshot(): Record<string, string> {
    return { ...this.files };
  }
}

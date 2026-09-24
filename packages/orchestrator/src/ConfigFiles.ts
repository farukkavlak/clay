import * as fs from 'node:fs';
import path from 'node:path';

/** Where module configurations are read from. A file is named by its path relative to the root configuration, with forward slashes. */
export interface ConfigFiles {
  /** The file's content, or undefined when there is no such file. */
  read(file: string): string | undefined;
}

export class DiskFiles implements ConfigFiles {
  constructor(private rootDir: string) {}

  read(file: string): string | undefined {
    try {
      return fs.readFileSync(path.resolve(this.rootDir, file), 'utf8');
    } catch (error) {
      // Only a file that is not there is missing; one that is there and cannot be opened is reported as it is.
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

/** Remembers every file read, so a plan can carry the configuration it was made from. */
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

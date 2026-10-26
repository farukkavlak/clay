import * as fs from 'node:fs';
import path from 'node:path';

/** Files are named by path relative to the root configuration, with forward slashes. */
export interface ConfigFiles {
  /** Undefined when the file does not exist. */
  read(file: string): string | undefined;
  /** The names of what `dir` holds, other than directories; none when it is not a directory. */
  list(dir: string): string[];
}

/** A link counts as what it points to. One that cannot be followed is listed, so reading it says why. */
function isDirectory(entry: fs.Dirent, dir: string): boolean {
  if (!entry.isSymbolicLink()) return entry.isDirectory();

  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') return false;

    throw error;
  }
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

  list(dir: string): string[] {
    const full = path.resolve(this.rootDir, dir);
    try {
      return fs
        .readdirSync(full, { withFileTypes: true })
        .filter((entry) => !isDirectory(entry, full))
        .map((entry) => entry.name);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];

      throw error;
    }
  }
}

export class InMemoryFiles implements ConfigFiles {
  constructor(private files: Record<string, string>) {}

  read(file: string): string | undefined {
    return this.files[file];
  }

  list(dir: string): string[] {
    return Object.keys(this.files)
      .filter((file) => path.posix.dirname(file) === dir)
      .map((file) => path.posix.basename(file));
  }
}

/** Reads each file and lists each directory once, so a run and its errors see one version; a saved plan carries the files, and its listings follow from them. */
export class RecordingFiles implements ConfigFiles {
  private files: Record<string, string> = {};
  private listings = new Map<string, string[]>();

  constructor(private source: ConfigFiles) {}

  read(file: string): string | undefined {
    if (Object.hasOwn(this.files, file)) return this.files[file];

    const content = this.source.read(file);
    if (content !== undefined) this.files[file] = content;

    return content;
  }

  list(dir: string): string[] {
    const listing = this.listings.get(dir) ?? this.source.list(dir);
    this.listings.set(dir, listing);

    return [...listing];
  }

  snapshot(): Record<string, string> {
    return { ...this.files };
  }
}

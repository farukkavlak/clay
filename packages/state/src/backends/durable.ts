import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

async function writeFlushed(target: string, content: string | Uint8Array, flag: 'w' | 'a'): Promise<void> {
  const handle = await fs.open(target, flag);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** On disk once it returns, so a power loss cannot leave the file empty. Its name is the directory's, flushed by `syncDir`. */
export const writeSynced = (target: string, content: string | Uint8Array) => writeFlushed(target, content, 'w');

export const appendSynced = (target: string, content: string) => writeFlushed(target, content, 'a');

/** A rename, a link or a new file lives in its directory, which a file's flush leaves behind. */
export async function syncDir(dir: string): Promise<void> {
  // Windows cannot flush a directory; NTFS logs the rename itself.
  if (process.platform === 'win32') return;

  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Written whole or not at all, in a folder made where it is missing, so a power loss never leaves a file cut short. */
export async function replaceSynced(target: string, content: string): Promise<void> {
  const holder = path.dirname(target);
  const made = await fs.mkdir(holder, { recursive: true });
  if (made !== undefined) await syncDir(path.dirname(made));
  // A name of its own, as no lock keeps two writers of the file apart.
  const filling = `${target}.${randomUUID()}`;
  try {
    await writeSynced(filling, content);
    await fs.rename(filling, target);
  } finally {
    await fs.rm(filling, { force: true });
  }
  await syncDir(holder);
}

import fs, { FileHandle } from 'node:fs/promises';
import { vi } from 'vitest';

/** For a mocked `node:fs/promises`: the lock and the state are written through a handle, which then writes nothing. */
export function openNothing(): void {
  const handle: Partial<FileHandle> = { writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() };
  vi.mocked(fs.open).mockResolvedValue(handle as FileHandle);
}

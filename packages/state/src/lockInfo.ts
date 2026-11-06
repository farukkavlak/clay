import { randomUUID } from 'node:crypto';
import os from 'node:os';

/** Who holds the state, so a second run can name it and tell one that is gone from one that runs. */
export interface LockInfo {
  readonly id: string;
  /** The command that took the lock, as `apply` or `state rm`. */
  readonly operation: string;
  readonly who: string;
  readonly host: string;
  readonly pid: number;
  /** An ISO 8601 time. */
  readonly created: string;
}

function userName(): string {
  try {
    return os.userInfo().username;
  } catch (error) {
    // A user the system has no entry for, as in some containers.
    if ((error as NodeJS.ErrnoException).code === 'ERR_SYSTEM_ERROR') return 'unknown';

    throw error;
  }
}

export function newLockInfo(operation: string): LockInfo {
  return { id: randomUUID(), operation, who: userName(), host: os.hostname(), pid: process.pid, created: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A pid of 0 or below names a process group to `kill`, not one process. */
function isLockInfo(value: unknown): value is LockInfo {
  if (!isRecord(value)) return false;

  const texts = ['id', 'operation', 'who', 'host', 'created'].every((key) => typeof value[key] === 'string');
  return texts && typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0;
}

/** Undefined for what a lock that was cut short or written by something else holds. */
export function lockInfoFrom(text: string): LockInfo | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isLockInfo(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;

    throw error;
  }
}

/** Signal 0 only asks whether the process is there; EPERM means it is, and belongs to another user. */
function runsHere(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;

    throw error;
  }
}

function lockedMessage(holder: LockInfo | undefined, howToFree: string): string {
  if (!holder) return `State is locked by a run that left no word of who it is. If that run is gone, ${howToFree}`;

  const { operation, who, host, pid, created } = holder;
  const by = `State is locked by ${operation} of ${who} on ${host}, pid ${pid}, since ${created}`;
  if (host === os.hostname() && !runsHere(pid)) return `${by}. No process ${pid} runs on this machine, so that run looks gone. If it is, ${howToFree}`;

  return `${by}. If that run is gone, ${howToFree}`;
}

/** `howToFree` says how this backend releases a lock its run left behind. */
export class StateLocked extends Error {
  constructor(holder: LockInfo | undefined, howToFree: string) {
    super(lockedMessage(holder, howToFree));
    this.name = 'StateLocked';
  }
}

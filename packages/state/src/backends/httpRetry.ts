import { NumberError } from '@clay/contracts';

import { Settings } from './settings';

/** How the HTTP backend takes a request again: the waits and the timeout in seconds, as the block gives them. */
export interface Retry {
  /** Tries after the first. */
  readonly max: number;
  readonly waitMin: number;
  readonly waitMax: number;
  /** How long one try may take, its body read whole. */
  readonly timeout: number;
}

export const RETRY_NAMES = ['retry_max', 'retry_wait_min', 'retry_wait_max', 'timeout'];

interface Range {
  readonly least: number;
  readonly most: number;
  readonly unit: string;
}

const TRIES: Range = { least: 0, most: 100, unit: 'tries' };
const WAIT: Range = { least: 0, most: 3600, unit: 'seconds' };
const TIMEOUT: Range = { least: 1, most: 3600, unit: 'seconds' };

function whole(settings: Settings, name: string, fallback: number, { least, most, unit }: Range): number {
  const written = settings.number(name);
  if (written === undefined) return fallback;

  let value: number;
  try {
    value = written.toSafeInteger();
  } catch (error) {
    if (error instanceof NumberError) settings.refuse(`${name} of backend "http" is ${written.toString()}, which is not a whole number`, name);

    throw error;
  }
  if (value < least || value > most) settings.refuse(`${name} of backend "http" is ${value}, and it takes ${least} to ${most} ${unit}`, name);

  return value;
}

/** Terraform's defaults, and a timeout it does not have, so a server that never answers cannot hold a run. */
export function retryFrom(settings: Settings): Retry {
  const max = whole(settings, 'retry_max', 2, TRIES);
  const waitMin = whole(settings, 'retry_wait_min', 1, WAIT);
  const waitMax = whole(settings, 'retry_wait_max', 30, WAIT);
  const timeout = whole(settings, 'timeout', 30, TIMEOUT);
  if (waitMin > waitMax) settings.refuse(`retry_wait_min of backend "http" is ${waitMin}, longer than retry_wait_max, ${waitMax}`, 'retry_wait_min');

  return { max, waitMin, waitMax, timeout };
}

/** A 501 says the server has no such method, which another try does not change. */
export const passing = (status: number) => status === 429 || (status >= 500 && status !== 501);

/** The shortest wait, doubled after each try, up to the longest. */
export const backoff = ({ waitMin, waitMax }: Retry, tried: number) => Math.min(waitMin * 2 ** (tried - 1), waitMax);

/** What `Retry-After` asks for, in seconds or as an HTTP date; undefined where it says neither. */
export function askedWait(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;

  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text);

  // Date.parse takes "1.5" and "-1" as dates too; an HTTP date is the one form it prints back.
  const at = Date.parse(text);
  return !Number.isNaN(at) && new Date(at).toUTCString() === text ? Math.max(at - now, 0) / 1000 : undefined;
}

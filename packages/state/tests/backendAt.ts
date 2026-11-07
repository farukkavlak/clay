import { HttpBackend, Retry, Sleep } from '../src';
import { Roots } from '../src/backends/httpRequest';

export interface Methods {
  update?: string;
  lock?: string;
  unlock?: string;
}

/** No try after the first, so a test of one failing answer sees it. */
export const ONCE: Retry = { max: 0, waitMin: 0, waitMax: 0, timeout: 5 };

/** A backend on the server at `base`, with the state at `/<name>` and the lock at `/lock`. */
export const backendAt = (base: string, methods: Methods = {}, name = 'state', retry: Retry = ONCE, sleep?: Sleep, roots?: Roots) =>
  new HttpBackend(
    {
      address: new URL(`${base}/${name}`),
      updateMethod: methods.update ?? 'POST',
      lockAddress: new URL(`${base}/lock`),
      lockMethod: methods.lock ?? 'LOCK',
      unlockAddress: new URL(`${base}/lock`),
      unlockMethod: methods.unlock ?? 'UNLOCK',
      retry,
    },
    sleep,
    roots
  );

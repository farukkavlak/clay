import { HttpBackend } from '../src';

export interface Methods {
  update?: string;
  lock?: string;
  unlock?: string;
}

/** A backend on the server at `base`, with the state at `/<name>` and the lock at `/lock`. */
export const backendAt = (base: string, methods: Methods = {}, name = 'state') =>
  new HttpBackend({
    address: new URL(`${base}/${name}`),
    updateMethod: methods.update ?? 'POST',
    lockAddress: new URL(`${base}/lock`),
    lockMethod: methods.lock ?? 'LOCK',
    unlockAddress: new URL(`${base}/lock`),
    unlockMethod: methods.unlock ?? 'UNLOCK',
  });

import { Address } from '@clay/contracts';
import { ConfigError, Range } from '@clay/parser';

import { asError } from './asError';
import { scopeOf } from './keys';

/** The same problem, said with the place it was written, the block that holds it and the module instance it ran in. */
export function configError(error: unknown, range: Range, context: string, address: Address): ConfigError {
  // An error that already knows a place knows a closer one than this.
  if (error instanceof ConfigError) return error;

  return new ConfigError(asError(error).message, range, { context, module: scopeOf(address) || undefined, cause: error });
}

/** Runs the work and, if it fails, says where the value it was working on was written. */
export function locate<T>(range: Range, context: string, address: Address, resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    throw configError(error, range, context, address);
  }
}

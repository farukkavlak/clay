import { Address } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { asError } from './asError';
import { scopeOf } from './keys';

/** A resolve error names the reference; this adds where it was read. */
export function withPlace(error: unknown, position: Position, block: string, address: Address): ConfigError {
  // An error that already knows a place knows a closer one than this.
  if (error instanceof ConfigError) return error;

  return new ConfigError(asError(error).message, position, { block, module: scopeOf(address) || undefined }, { cause: error });
}

/** Runs the work and, if it fails, says where the value it was working on was written. */
export function tryAt<T>(position: Position, block: string, address: Address, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw withPlace(error, position, block, address);
  }
}

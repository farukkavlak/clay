import { Address } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { asError } from './asError';
import { scopeOf } from './keys';

/** A resolve error names the reference; this adds where it was read. */
export function withPlace(error: unknown, position: Position, block: string, address: Address): ConfigError {
  const place = { block, module: scopeOf(address) || undefined };

  // An error that already knows a position knows a closer one than this; the block around it is still news.
  if (error instanceof ConfigError) return error.block ? error : new ConfigError(error.message, error.position, place, { cause: error });

  return new ConfigError(asError(error).message, position, place, { cause: error });
}

/** Runs the work and, if it fails, says where the value it was working on was written. */
export function tryAt<T>(position: Position, block: string, address: Address, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw withPlace(error, position, block, address);
  }
}

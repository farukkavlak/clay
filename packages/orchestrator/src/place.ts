import { ConfigError, Position } from '@clay/parser';

import { asError } from './asError';
import { Context, scopeOf } from './keys';

/** Without a position, the caller adds one. */
export function placed(message: string, position?: Position): Error {
  return position ? new ConfigError(message, position) : new Error(message);
}

export function withPlace(error: unknown, position: Position, block: string, address: Context): ConfigError {
  const place = { block, module: scopeOf(address) || undefined };

  // An existing position is more precise; only the block is added.
  if (error instanceof ConfigError) return error.block ? error : new ConfigError(error.message, error.position, place, { cause: error });

  return new ConfigError(asError(error).message, position, place, { cause: error });
}

export function tryAt<T>(position: Position, block: string, address: Context, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw withPlace(error, position, block, address);
  }
}

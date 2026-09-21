import { Range } from './Range';

interface Place {
  /** The block the problem was found in, as the config spells it: `resource "local_file" "a"`. */
  context?: string;
  /** The module instance that block belongs to, `module.a`, when it is not the root one. */
  module?: string;
  cause?: unknown;
}

/** A problem in a configuration file, at the place that caused it. */
export class ConfigError extends Error {
  readonly context?: string;
  readonly module?: string;

  constructor(
    message: string,
    readonly range: Range,
    place: Place = {}
  ) {
    super(message, { cause: place.cause });
    this.name = 'ConfigError';
    this.context = place.context;
    this.module = place.module;
  }
}

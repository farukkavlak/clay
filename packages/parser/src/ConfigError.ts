import { Position } from './Position';

interface Place {
  /** The block the problem was found in, as the config spells it: `resource "local_file" "a"`. */
  block?: string;
  /** The module instance that block belongs to, `module.a`, when it is not the root one. */
  module?: string;
}

/** A problem in a configuration file, at the place that caused it. */
export class ConfigError extends Error {
  readonly block?: string;
  readonly module?: string;

  constructor(
    message: string,
    readonly position: Position,
    place: Place = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConfigError';
    this.block = place.block;
    this.module = place.module;
  }
}

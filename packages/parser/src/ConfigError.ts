import { Position } from './Position';

interface Place {
  /** As the config spells it: `resource "local_file" "a"`. */
  block?: string;
  /** `module.a`; absent at the root. */
  module?: string;
}

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

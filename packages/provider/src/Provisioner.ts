import type { Schema } from './Schema';

/** A step run on an object once it is made, named by the type a `provisioner` block gives. Numbers in a configuration arrive as `ExactNumber`. */
export interface Provisioner {
  readonly type: string;

  getSchema(): Promise<Schema>;

  /** Throws on an invalid configuration. A value may be UNKNOWN until apply, and is checked again then. */
  validate(config: Record<string, unknown>): Promise<void>;

  /** Throws when the step fails. Each line it prints goes to `output` as it comes, without its line break. */
  run(config: Record<string, unknown>, output: (line: string) => void): Promise<void>;
}

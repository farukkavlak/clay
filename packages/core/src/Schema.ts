import { types } from './Type';
import type { Type } from './Type';

export interface SchemaDefinition {
  type: Type;
  required?: boolean;
  /** A change to it replaces the resource. */
  forceNew?: boolean;
  /** Set by the provider; the configuration may set it only with `optional`. A plan with no change keeps it as read; any change recomputes it unless `kept`. */
  computed?: boolean;
  /** With `computed`: the configuration may set it, and the provider computes it otherwise. */
  optional?: boolean;
  /** With `computed`: fixed at create until replace, so an update keeps it as read. */
  kept?: boolean;
  /** Whatever it holds is sensitive, the configuration's or the provider's. */
  sensitive?: boolean;
  /** With `computed`: sensitive as a whole where any of these, as given, holds a sensitive part. */
  sensitiveWith?: string[];
  /** Planned where the configuration leaves it out, so writing it out changes nothing. */
  default?: unknown;
}

export type Schema = Record<string, SchemaDefinition>;

export function typeIn(schema: Schema, name: string): Type {
  return Object.hasOwn(schema, name) ? schema[name].type : types.dynamic;
}

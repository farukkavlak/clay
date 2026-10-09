import { AttributePath, Type, types, UNKNOWN } from '@clay/contracts';

import { Value, valueOf, withSensitive } from '../Value';

/** Thrown when a value is known only after apply; `type` is its future type, where known, and `sensitive` its sensitive parts. */
export class UnresolvedReferenceError extends Error {
  constructor(
    message: string,
    readonly type: Type = types.dynamic,
    readonly sensitive: readonly AttributePath[] = []
  ) {
    super(message);
    this.name = 'UnresolvedReferenceError';
  }
}

export function unknownOf(error: UnresolvedReferenceError): Value {
  return withSensitive(valueOf(error.type, UNKNOWN), error.sensitive);
}

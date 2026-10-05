import { Type, types } from '@clay/contracts';

/** Thrown when a value is known only after apply; `type` is its future type, where known. */
export class UnresolvedReferenceError extends Error {
  constructor(
    message: string,
    readonly type: Type = types.dynamic
  ) {
    super(message);
    this.name = 'UnresolvedReferenceError';
  }
}

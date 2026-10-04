import { Type, types } from '@clay/contracts';

/** Thrown when a reference, or a call, reads something that only exists after an apply; `type` is what it will be, where that is known. */
export class UnresolvedReferenceError extends Error {
  constructor(
    message: string,
    readonly type: Type = types.dynamic
  ) {
    super(message);
    this.name = 'UnresolvedReferenceError';
  }
}

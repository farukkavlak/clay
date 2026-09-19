/** Thrown when a reference points at something that only exists after an apply. */
export class UnresolvedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedReferenceError';
  }
}

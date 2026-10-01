import { isUnknown } from '@clay/contracts';

/** A value as a message shows it: one not known yet, or in part, says so where it is not. */
export function shown(value: unknown): string {
  if (value === undefined) return '(none)';

  return JSON.stringify(value, (_, item: unknown) => (isUnknown(item) ? '(known after apply)' : item));
}

import { isUnknown } from '@clay/provider';

/** For messages; marks unknown parts. */
export function shown(value: unknown): string {
  if (value === undefined) return '(none)';

  return JSON.stringify(value, (_, item: unknown) => (isUnknown(item) ? '(known after apply)' : item));
}

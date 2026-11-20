import { ExactNumber } from './ExactNumber';
import { isRecord } from './isRecord';
import { isUnknown } from './unknown';

/** Equal members have equal keys. Strings are quoted, so none collides with a number or an unknown. */
export function memberKey(value: unknown): string {
  if (value instanceof ExactNumber) return `#${value.toString()}`;
  if (isUnknown(value)) return '?';
  // Nested sets are already ordered, so equal members give equal text.
  if (Array.isArray(value)) return `[${value.map((item) => memberKey(item)).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${memberKey(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

/** What a reference can spell after a dot, so every declared name can be referenced. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Reference prefixes, so no resource type or for name may use them. */
export const RESERVED_TYPES = new Set(['module', 'var', 'local', 'data', 'count', 'each', 'path', 'self']);

/** How a name is written, for the message that refuses one. */
export const NAME_RULE = 'starts with a letter or underscore, then letters, digits, underscores and dashes';

/** A name spelled like one could never be referenced. */
const KEYWORDS = new Set(['true', 'false', 'null']);

/** A name a configuration can declare. */
export function isName(name: string): boolean {
  return NAME.test(name) && !KEYWORDS.has(name);
}

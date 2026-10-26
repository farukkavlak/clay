import { AttributeValue, ReferenceNode } from '../ast';
import { ConfigError } from '../ConfigError';
import { ParsedReference, parseReference, spellReference, Step } from '../reference';

const WAITED_FOR = new Set<ParsedReference['kind']>(['resource', 'data', 'variable', 'local', 'module']);
const WAITS_FOR = 'depends_on is a list of resources, data sources, variables, locals, modules and their outputs, as in [local_file.a]';

/** The one step a whole object may have: the output of a module. */
const outputStep = (reference: ParsedReference) => (reference.kind === 'module' && reference.path.length > 0 && 'name' in reference.path[0] ? 1 : 0);

/** The nearest whole object: `module.m.out` for `module.m[0].out`, since `module.m` would wait for more. */
function wholeOf(parts: Step[], reference: ParsedReference): Step[] {
  const head = parts.slice(0, parts.length - reference.path.length);
  const [first, second] = reference.path;
  if (reference.kind === 'module' && !('name' in first) && second && 'name' in second) return [...head, second];

  return [...head, ...reference.path.slice(0, outputStep(reference))];
}

/** The graph orders blocks, not instances, so an index could not mean what it says. */
function waitedFor(item: AttributeValue): ReferenceNode {
  if (item.type !== 'Reference') throw new ConfigError(WAITS_FOR, item.position);

  const reference = parseReference(item.value, item.position);
  if (!WAITED_FOR.has(reference.kind)) throw new ConfigError(WAITS_FOR, item.position);
  if (reference.path.length > outputStep(reference)) {
    const whole = spellReference(wholeOf(item.value, reference));
    throw new ConfigError(`depends_on waits for a whole object: write ${whole}, not ${spellReference(item.value)}`, item.position);
  }

  return item;
}

/** Read as written, so the order is known before any value is. */
export function dependsOnOf(value: AttributeValue): ReferenceNode[] {
  if (value.type !== 'List') throw new ConfigError(WAITS_FOR, value.position);

  return value.value.map((item) => waitedFor(item));
}

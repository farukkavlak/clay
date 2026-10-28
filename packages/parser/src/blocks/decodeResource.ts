import { AttributeValue, IgnoredPath, Lifecycle, ProvisionerBlock, ResourceBlock } from '../ast';
import { Attribute, Block } from '../body';
import { ConfigError } from '../ConfigError';
import { stepKey } from '../reference';
import { attributesIn, attributesOnly, flagOf } from './attributes';
import { dependsOnOf } from './dependsOn';

const isAll = (value: AttributeValue) => value.type === 'Reference' && value.value.length === 1 && 'name' in value.value[0] && value.value[0].name === 'all';

/** Why a value that is no reference names no path. */
function notAPath(item: AttributeValue): ConfigError {
  if (item.type === 'For' && item.splat) return new ConfigError('ignore_changes names keys and indexes written out, not [*]', item.position);
  if (item.type === 'String' || item.type === 'Template') return new ConfigError('ignore_changes names an attribute, written without quotes.', item.position);

  return new ConfigError('ignore_changes names an attribute and the keys and indexes below it, as tags["Name"]', item.position);
}

/** Written out, as `tags["Name"]` and `items[0]` are, so the path is known before any value is. */
function ignoredPath(item: AttributeValue): IgnoredPath {
  const [first, ...steps] = item.type === 'Reference' ? item.value : [];
  if (first === undefined || !('name' in first)) throw notAPath(item);
  if (first.name === 'all') throw new ConfigError('all is written alone, not in a list', item.position);

  const path: (string | number)[] = [first.name];
  for (const step of steps) {
    if ('index' in step) throw new ConfigError('ignore_changes names keys and indexes written out, not a value to read', item.position);
    path.push(stepKey(step));
  }

  return { path, position: item.position };
}

/** `all`, or a list of attributes: `[content, tags["Name"], items[0]]`. */
function ignoreChangesOf(value: AttributeValue): 'all' | IgnoredPath[] {
  if (isAll(value)) return 'all';
  if (value.type !== 'List') throw new ConfigError('ignore_changes is a list of attributes, or all.', value.position);

  return value.value.map((item) => ignoredPath(item));
}

/** What one argument of a lifecycle block sets; checked as it is read, and again when the block is. */
export function lifecycleArgument({ name, value, position }: Attribute): Partial<Lifecycle> {
  switch (name) {
    case 'prevent_destroy': {
      return { preventDestroy: flagOf(value, name) };
    }
    case 'create_before_destroy': {
      return { createBeforeDestroy: flagOf(value, name) };
    }
    case 'ignore_changes': {
      return { ignoreChanges: ignoreChangesOf(value) };
    }
    default: {
      throw new ConfigError(`lifecycle takes only "prevent_destroy", "create_before_destroy" and "ignore_changes", not "${name}"`, position);
    }
  }
}

/** Read with the block, before any reference has a value, so what it holds is written out. */
function decodeLifecycle(block: Block): Lifecycle {
  return Object.assign({ position: block.position }, ...attributesOnly(block.body).map((item) => lifecycleArgument(item))) as Lifecycle;
}

/** A word written out, read with the block, so what a failure does is known before any value is. */
export function onFailureOf(value: AttributeValue): 'continue' | 'fail' {
  const [word, ...rest] = value.type === 'Reference' ? value.value : [];
  if (word !== undefined && rest.length === 0 && 'name' in word && (word.name === 'continue' || word.name === 'fail')) return word.name;
  const quoted = value.type === 'String' || value.type === 'Template';

  throw new ConfigError(`on_failure is continue or fail${quoted ? ', written without quotes' : ''}.`, value.position);
}

/** `on_failure` is read by the engine, never given to the provisioner. */
function decodeProvisioner({ labels: [provisionerType], body, position }: Block): ProvisionerBlock {
  const { on_failure: onFailure, ...attributes } = attributesIn(body);

  return { provisionerType, ...(onFailure && { onFailure: onFailureOf(onFailure) }), attributes, position };
}

export function decodeResource(block: Block, [resourceType, name]: string[]): ResourceBlock {
  let lifecycle: Lifecycle | undefined;
  const provisioners: ProvisionerBlock[] = [];
  const {
    count,
    for_each: forEach,
    depends_on: dependsOn,
    ...attributes
  } = attributesIn(block.body, (inner) => {
    if (inner.name === 'provisioner') provisioners.push(decodeProvisioner(inner));
    else lifecycle = decodeLifecycle(inner);
  });
  if (count && forEach) throw new ConfigError(`resource "${resourceType}" "${name}" has count or for_each, not both`, forEach.position);

  return {
    type: 'Resource',
    resourceType,
    name,
    ...(count && { count }),
    ...(forEach && { forEach }),
    ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
    ...(lifecycle && { lifecycle }),
    ...(provisioners.length > 0 && { provisioners }),
    attributes,
    position: block.position,
  };
}

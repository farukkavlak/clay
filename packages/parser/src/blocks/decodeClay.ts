import { BackendBlock } from '../ast';
import { Attribute, Block, Header } from '../body';
import { checkConstant } from '../checkConstant';
import { ConfigError } from '../ConfigError';
import { attributesIn } from './attributes';

const ONLY_BACKEND = 'clay takes only a backend block';

/** What a backend's type takes is checked by whatever builds it, which knows the types. */
export function checkClayHeader({ name, labels, position, open }: Header): void {
  if (name !== 'backend') throw new ConfigError(ONLY_BACKEND, position);
  if (labels.length === 0) throw new ConfigError("Expect backend type string after 'backend'.", open);
  if (labels.length > 1) throw new ConfigError("Expect '{' after backend type.", labels[1].position);
}

export function refuseClayArgument({ value }: Attribute): never {
  throw new ConfigError(ONLY_BACKEND, value.position);
}

/** Read before anything has a value, since the state it names is where values come from. */
export function checkBackendArgument({ name, value }: Attribute, { labels: [type] }: Header): void {
  checkConstant(value, `${name} of backend "${type.value}"`);
}

/** A block a file may write with no backend in it gives no statement, so two backends across a module are a duplicate like any other. */
export function decodeClay(block: Block): BackendBlock[] {
  const backends: BackendBlock[] = [];
  attributesIn(block.body, (inner) => backends.push({ type: 'Backend', backendType: inner.labels[0], attributes: attributesIn(inner.body), position: inner.position }));

  return backends;
}

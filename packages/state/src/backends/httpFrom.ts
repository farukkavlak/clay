import { BackendBlock, ConfigError } from '@clay/parser';

import { checkNames, Text, textOf } from './blockText';
import { HttpBackend } from './HttpBackend';

const TAKES = ['address', 'update_method', 'lock_address', 'lock_method', 'unlock_address', 'unlock_method'];

/** A token, as a request line spells a method. */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** fetch sends none of these. */
const FORBIDDEN = new Set(['CONNECT', 'TRACE', 'TRACK']);

function parsed({ value, at }: Text, name: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ConfigError(`${name} of backend "http" is "${value}", which is not a URL`, at.position);

    throw error;
  }
}

/** Credentials in the address would be printed in every message that names where the state is. */
export function urlProblem(url: URL): 'scheme' | 'credentials' | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
  if (url.username !== '' || url.password !== '') return 'credentials';

  return undefined;
}

/** The value is left out of the refusal of credentials, which would print them. */
function urlOf(text: Text, name: string): URL {
  const url = parsed(text, name);
  const problem = urlProblem(url);
  if (problem === 'scheme') throw new ConfigError(`${name} of backend "http" is "${text.value}", and only http and https are taken`, text.at.position);
  if (problem === 'credentials') throw new ConfigError(`${name} of backend "http" holds credentials, which would be printed wherever the address is`, text.at.position);

  return url;
}

function methodOf(block: BackendBlock, name: string, fallback: string): string {
  const text = textOf(block, name);
  if (text === undefined) return fallback;

  if (!METHOD.test(text.value)) throw new ConfigError(`${name} of backend "http" is "${text.value}", which is no HTTP method`, text.at.position);
  if (FORBIDDEN.has(text.value.toUpperCase())) throw new ConfigError(`${name} of backend "http" is "${text.value}", which a request cannot be sent with`, text.at.position);

  return text.value;
}

/** Each address is required where it is not implied, so a run can never write the state without the lock. */
function required(block: BackendBlock, name: string): URL {
  const text = textOf(block, name);
  if (text === undefined) throw new ConfigError(`backend "http" needs "${name}"`, block.backendType.position);

  return urlOf(text, name);
}

export function httpFrom(block: BackendBlock): HttpBackend {
  checkNames(block, TAKES);

  const address = required(block, 'address');
  const lockAddress = required(block, 'lock_address');
  const unlock = textOf(block, 'unlock_address');

  return new HttpBackend({
    address,
    updateMethod: methodOf(block, 'update_method', 'POST'),
    lockAddress,
    lockMethod: methodOf(block, 'lock_method', 'LOCK'),
    unlockAddress: unlock === undefined ? lockAddress : urlOf(unlock, 'unlock_address'),
    unlockMethod: methodOf(block, 'unlock_method', 'UNLOCK'),
  });
}

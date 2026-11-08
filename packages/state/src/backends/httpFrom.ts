import { HttpBackend } from './HttpBackend';
import { credentialsFrom, PASSWORD, USERNAME } from './httpCredentials';
import { RETRY_NAMES, retryFrom } from './httpRetry';
import { caFrom, CLIENT_CERTIFICATE, CLIENT_KEY, clientFrom } from './httpTls';
import { checkNames, Environment, Settings } from './settings';

const SECRETS = new Map([
  ['username', USERNAME],
  ['password', PASSWORD],
  ['client_certificate', CLIENT_CERTIFICATE],
  ['client_private_key', CLIENT_KEY],
]);
const TAKES = ['address', 'update_method', 'lock_address', 'lock_method', 'unlock_address', 'unlock_method', 'ca_certificate', ...RETRY_NAMES];

/** A token, as a request line spells a method. */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** CONNECT opens a tunnel, and TRACE and TRACK echo the request back: none of them keeps a state. */
const FORBIDDEN = new Set(['CONNECT', 'TRACE', 'TRACK']);

function parsed(settings: Settings, value: string, name: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    if (error instanceof TypeError) settings.refuse(`${name} of backend "${settings.type}" is "${value}", which is not a URL`, name);

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
export function urlOf(settings: Settings, value: string, name: string): URL {
  const url = parsed(settings, value, name);
  const problem = urlProblem(url);
  if (problem === 'scheme') settings.refuse(`${name} of backend "${settings.type}" is "${value}", and only http and https are taken`, name);
  if (problem === 'credentials') settings.refuse(`${name} of backend "${settings.type}" holds credentials, which would be printed wherever the address is`, name);

  return url;
}

function methodOf(settings: Settings, name: string, fallback: string): string {
  const value = settings.text(name);
  if (value === undefined) return fallback;

  if (!METHOD.test(value)) settings.refuse(`${name} of backend "http" is "${value}", which is no HTTP method`, name);
  if (FORBIDDEN.has(value.toUpperCase())) settings.refuse(`${name} of backend "http" is "${value}", which opens a tunnel or echoes the request, and keeps no state`, name);

  return value;
}

/** Each address is required where it is not implied, so a run can never write the state without the lock. */
function required(settings: Settings, name: string): URL {
  const value = settings.text(name);
  if (value === undefined) settings.refuse(`backend "http" needs "${name}"`);

  return urlOf(settings, value, name);
}

/** Refuses a credential written in the block, which would be checked in with it. */
function checkNoSecrets(settings: Settings): void {
  for (const name of settings.names) {
    const holder = SECRETS.get(name);
    if (holder !== undefined) settings.refuse(`${name} of backend "http" is read from ${holder}, never from the configuration, which is checked in`, name);
  }
}

/** A CA file with no https address to ask is a mistake in the address or the setting. A client certificate is the environment's, which serves every backend, so it goes only where an address is https. */
function checkHttps(settings: Settings, addresses: readonly URL[]): void {
  if (settings.text('ca_certificate') !== undefined && !addresses.some(({ protocol }) => protocol === 'https:'))
    settings.refuse('ca_certificate of backend "http" is given, and no address is https, so no CA would be asked', 'ca_certificate');
}

export function httpFrom(settings: Settings, workingDir: string, env: Environment): HttpBackend {
  checkNoSecrets(settings);
  checkNames(settings, TAKES);

  const address = required(settings, 'address');
  const lockAddress = required(settings, 'lock_address');
  const unlock = settings.text('unlock_address');
  const unlockAddress = unlock === undefined ? lockAddress : urlOf(settings, unlock, 'unlock_address');
  checkHttps(settings, [address, lockAddress, unlockAddress]);

  return new HttpBackend({
    address,
    updateMethod: methodOf(settings, 'update_method', 'POST'),
    lockAddress,
    lockMethod: methodOf(settings, 'lock_method', 'LOCK'),
    unlockAddress,
    unlockMethod: methodOf(settings, 'unlock_method', 'UNLOCK'),
    credentials: credentialsFrom(env),
    retry: retryFrom(settings),
    ca: caFrom(settings, workingDir),
    client: clientFrom(env),
  });
}

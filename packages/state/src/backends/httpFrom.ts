import { HttpBackend } from './HttpBackend';
import { credentialsFrom, PASSWORD, USERNAME } from './httpCredentials';
import { RETRY_NAMES, retryFrom } from './httpRetry';
import { caFrom, CLIENT_CERTIFICATE, CLIENT_KEY, clientFrom } from './httpTls';
import { checkNames, checkNoSecrets, Environment, requiredText, Settings, urlOf } from './settings';

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

function methodOf(settings: Settings, name: string, fallback: string): string {
  const value = settings.text(name);
  if (value === undefined) return fallback;

  if (!METHOD.test(value)) settings.refuse(`${name} of backend "http" is "${value}", which is no HTTP method`, name);
  if (FORBIDDEN.has(value.toUpperCase())) settings.refuse(`${name} of backend "http" is "${value}", which opens a tunnel or echoes the request, and keeps no state`, name);

  return value;
}

/** Each address is required where it is not implied, so a run can never write the state without the lock. */
const requiredUrl = (settings: Settings, name: string): URL => urlOf(settings, requiredText(settings, name), name);

/** A CA file with no https address to ask is a mistake in the address or the setting. A client certificate is the environment's, which serves every backend, so it goes only where an address is https. */
function checkHttps(settings: Settings, addresses: readonly URL[]): void {
  if (settings.text('ca_certificate') !== undefined && !addresses.some(({ protocol }) => protocol === 'https:'))
    settings.refuse('ca_certificate of backend "http" is given, and no address is https, so no CA would be asked', 'ca_certificate');
}

export function httpFrom(settings: Settings, workingDir: string, env: Environment): HttpBackend {
  checkNoSecrets(settings, SECRETS);
  checkNames(settings, TAKES);

  const address = requiredUrl(settings, 'address');
  const lockAddress = requiredUrl(settings, 'lock_address');
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

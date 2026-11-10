import { ACCOUNT_KEY, AzureBackend, AzureCredential, SAS_TOKEN } from './AzureBackend';
import { urlOf } from './httpFrom';
import { checkNames, Environment, Settings, variable } from './settings';

const SECRETS = new Map([
  ['access_key', ACCOUNT_KEY],
  ['sas_token', SAS_TOKEN],
]);
const TAKES = ['storage_account_name', 'container_name', 'key', 'endpoint'];

const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** A blob name holds 1024 characters, and the lock's is the key and ".lock". */
const LONGEST_KEY = 1024 - '.lock'.length;

/** Refuses a credential written in the block, which would be checked in with it. */
function checkNoSecrets(settings: Settings): void {
  for (const name of settings.names) {
    const holder = SECRETS.get(name);
    if (holder !== undefined) settings.refuse(`${name} of backend "azure" is read from ${holder}, never from the configuration, which is checked in`, name);
  }
}

function required(settings: Settings, name: string): string {
  const value = settings.text(name);
  if (value === undefined) settings.refuse(`backend "azure" needs "${name}"`);

  return value;
}

function accountOf(settings: Settings): string {
  const account = required(settings, 'storage_account_name');
  if (!ACCOUNT.test(account))
    settings.refuse(`storage_account_name of backend "azure" is "${account}", and an account name is 3 to 24 lowercase letters and digits`, 'storage_account_name');

  return account;
}

function containerOf(settings: Settings): string {
  const container = required(settings, 'container_name');
  if (!CONTAINER.test(container))
    settings.refuse(
      `container_name of backend "azure" is "${container}", and a container name is 3 to 63 lowercase letters, digits and single hyphens between them`,
      'container_name'
    );

  return container;
}

/** The SDK resolves "." and ".." in the path, which would name another blob, or one in another container. */
function keyOf(settings: Settings): string {
  const key = required(settings, 'key');
  const parts = key.split('/');
  if (key.length > LONGEST_KEY) settings.refuse(`key of backend "azure" is ${key.length} characters long, and ${LONGEST_KEY} at most leaves room for ".lock"`, 'key');
  if (key.startsWith('/') || key.endsWith('/')) settings.refuse(`key of backend "azure" is "${key}", which must not start or end with "/"`, 'key');
  if (parts.includes('')) settings.refuse(`key of backend "azure" is "${key}", which must not hold "//"`, 'key');
  if (parts.some((part) => part === '.' || part === '..')) settings.refuse(`key of backend "azure" is "${key}", which must not hold a "." or ".." part`, 'key');
  if (key.endsWith('.')) settings.refuse(`key of backend "azure" is "${key}", which must not end with "."`, 'key');

  return key;
}

/** A SAS token in the endpoint would be printed wherever the address is. */
function endpointOf(settings: Settings): URL | undefined {
  const value = settings.text('endpoint');
  if (value === undefined) return undefined;

  const url = urlOf(settings, value, 'endpoint');
  if (url.search !== '' || url.hash !== '') settings.refuse(`endpoint of backend "azure" holds a query or a fragment; a SAS token is read from ${SAS_TOKEN}`, 'endpoint');

  return url;
}

/** The key or the token, from the environment alone: the configuration is checked in. */
function credentialFrom(env: Environment): AzureCredential | undefined {
  const accountKey = variable(env, ACCOUNT_KEY);
  const sasToken = variable(env, SAS_TOKEN);
  if (accountKey !== undefined && sasToken !== undefined) throw new Error(`${ACCOUNT_KEY} and ${SAS_TOKEN} are both set; backend "azure" takes one of them`);
  if (accountKey !== undefined && (!BASE64.test(accountKey) || accountKey.length % 4 !== 0)) throw new Error(`${ACCOUNT_KEY} is not base64, as an account key is`);
  if (accountKey !== undefined) return { accountKey };

  return sasToken === undefined ? undefined : { sasToken: sasToken.replace(/^\?/, '') };
}

export function azureFrom(settings: Settings, _workingDir: string, env: Environment): AzureBackend {
  checkNoSecrets(settings);
  checkNames(settings, TAKES);

  return new AzureBackend({
    account: accountOf(settings),
    container: containerOf(settings),
    key: keyOf(settings),
    endpoint: endpointOf(settings),
    credential: credentialFrom(env),
  });
}

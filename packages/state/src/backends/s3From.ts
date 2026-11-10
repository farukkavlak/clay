import { urlOf } from './httpFrom';
import { S3Backend } from './S3Backend';
import { checkNames, Environment, Settings, variable } from './settings';

const SECRETS = new Map([
  ['access_key', 'AWS_ACCESS_KEY_ID'],
  ['secret_key', 'AWS_SECRET_ACCESS_KEY'],
  ['token', 'AWS_SESSION_TOKEN'],
]);
const TAKES = ['bucket', 'key', 'region', 'endpoint', 'use_path_style'];

/** A key holds 1024 bytes in UTF-8, and the lock's is the key and ".lock". */
const LONGEST_KEY = 1024 - '.lock'.length;

/** A region is part of a host name. */
const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Refuses a credential written in the block, which would be checked in with it. */
function checkNoSecrets(settings: Settings): void {
  for (const name of settings.names) {
    const holder = SECRETS.get(name);
    if (holder !== undefined) settings.refuse(`${name} of backend "s3" is read from ${holder}, a profile or a role, never from the configuration, which is checked in`, name);
  }
}

function required(settings: Settings, name: string): string {
  const value = settings.text(name);
  if (value === undefined) settings.refuse(`backend "s3" needs "${name}"`);

  return value;
}

function bucketOf(settings: Settings): string {
  const bucket = required(settings, 'bucket');
  if (bucket.includes('/')) settings.refuse(`bucket of backend "s3" is "${bucket}", and a bucket name holds no "/"`, 'bucket');

  return bucket;
}

/** S3 lists a key ending in "/" as a folder, and one with an empty part names another object than the path it reads as. */
function keyOf(settings: Settings): string {
  const key = required(settings, 'key');
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > LONGEST_KEY) settings.refuse(`key of backend "s3" is ${bytes} bytes long, and ${LONGEST_KEY} at most leaves room for ".lock"`, 'key');
  if (key.startsWith('/') || key.endsWith('/')) settings.refuse(`key of backend "s3" is "${key}", which must not start or end with "/"`, 'key');
  if (key.includes('//')) settings.refuse(`key of backend "s3" is "${key}", which must not hold "//"`, 'key');

  return key;
}

/** The block's region, or the environment's, as the AWS CLI reads it. */
function regionOf(settings: Settings, env: Environment): { readonly region: string; readonly inBlock: boolean } {
  const given = settings.text('region');
  const from = given === undefined ? ['AWS_REGION', 'AWS_DEFAULT_REGION'].find((name) => variable(env, name) !== undefined) : undefined;
  const region = given ?? (from === undefined ? undefined : variable(env, from));
  if (region === undefined) settings.refuse('backend "s3" needs "region", or AWS_REGION or AWS_DEFAULT_REGION in the environment');
  if (!REGION.test(region)) settings.refuse(`${from ?? 'region of backend "s3"'} is "${region}", which is no region`, 'region');

  return { region, inBlock: given !== undefined };
}

function endpointOf(settings: Settings): URL | undefined {
  const value = settings.text('endpoint');
  return value === undefined ? undefined : urlOf(settings, value, 'endpoint');
}

export function s3From(settings: Settings, _workingDir: string, env: Environment): S3Backend {
  checkNoSecrets(settings);
  checkNames(settings, TAKES);

  const { region, inBlock } = regionOf(settings, env);
  return new S3Backend({
    bucket: bucketOf(settings),
    key: keyOf(settings),
    region,
    regionInBlock: inBlock,
    endpoint: endpointOf(settings),
    pathStyle: settings.flag('use_path_style') ?? false,
  });
}

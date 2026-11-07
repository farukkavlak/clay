import { createPrivateKey, KeyObject, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ClientCertificate, Roots } from './httpRequest';
import { Environment, Settings, variable } from './settings';

export const CLIENT_CERTIFICATE = 'CLAY_HTTP_CLIENT_CERTIFICATE';
export const CLIENT_KEY = 'CLAY_HTTP_CLIENT_KEY';

/** The CAs a file holds, with the name it was given by, which `init` remembers. */
export interface CaFile {
  readonly name: string;
  readonly roots: Roots;
}

const BLOCK = /-----BEGIN ([^-]+)-----[\s\S]*?-----END \1-----/g;
const BEGIN = /-----BEGIN /g;

/** An error OpenSSL or the file system gave, which carries a code. */
const codeOf = (error: unknown): string => {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === undefined) throw error;

  return code;
};

/** Every block is read, as Node would skip one it cannot read and trust the rest. Text between blocks, as openssl prints, is left. */
function certificates(text: string, refuse: (problem: string) => never): string[] {
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length === 0) refuse('holds no PEM certificate');
  if (blocks.length !== text.match(BEGIN)?.length) refuse('holds a PEM block with no END line');

  return blocks.map(([block, label]) => {
    if (label !== 'CERTIFICATE') refuse(`holds a ${label} block, where only certificates are taken`);
    try {
      new X509Certificate(block);
    } catch (error) {
      refuse(`holds a certificate that cannot be read (${codeOf(error)})`);
    }
    return block;
  });
}

function readCa(settings: Settings, name: string, file: string): string[] {
  const of = `ca_certificate of backend "http" is "${name}", and ${file}`;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    settings.cannotUse(`${of} cannot be read (${codeOf(error)})`, 'ca_certificate');
  }

  return certificates(text, (problem) => settings.cannotUse(`${of} ${problem}`, 'ca_certificate'));
}

/** Read at the first https request of each command, so a CA that changes needs no `clay init`, and one gone stops no `init` that moves off it. */
export function caFrom(settings: Settings, workingDir: string): CaFile | undefined {
  const name = settings.text('ca_certificate');
  if (name === undefined) return undefined;

  let list: string[] | undefined;
  return { name, roots: () => (list ??= readCa(settings, name, path.resolve(workingDir, name))) };
}

/** Clay asks for no passphrase, which a run in CI could not give. */
function keyOf(text: string): KeyObject {
  if (text.includes('ENCRYPTED')) throw new Error(`${CLIENT_KEY} holds an encrypted key; Clay asks for no passphrase, so give the key unencrypted`);
  try {
    return createPrivateKey(text);
  } catch (error) {
    throw new Error(`${CLIENT_KEY} holds no private key Clay can read (${codeOf(error)})`, { cause: error });
  }
}

/** A key that is not the certificate's would fail only at the handshake, as a server refusing the client. */
export function clientFrom(env: Environment): ClientCertificate | undefined {
  const cert = variable(env, CLIENT_CERTIFICATE);
  const key = variable(env, CLIENT_KEY);
  if (cert === undefined && key === undefined) return undefined;
  if (cert === undefined || key === undefined) {
    const [set, unset] = cert === undefined ? [CLIENT_KEY, CLIENT_CERTIFICATE] : [CLIENT_CERTIFICATE, CLIENT_KEY];
    throw new Error(`${set} is set and ${unset} is not; a client certificate is sent only with its key`);
  }

  const [leaf] = certificates(cert, (problem) => {
    throw new Error(`${CLIENT_CERTIFICATE} ${problem}`);
  });
  if (!new X509Certificate(leaf).checkPrivateKey(keyOf(key))) throw new Error(`${CLIENT_KEY} is not the key of the first certificate in ${CLIENT_CERTIFICATE}`);

  return { cert, key };
}

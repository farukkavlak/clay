import { Environment } from './settings';

export const USERNAME = 'CLAY_HTTP_USERNAME';
export const PASSWORD = 'CLAY_HTTP_PASSWORD';

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** An empty variable counts as unset, as `export NAME=` is how a shell often clears one. */
const valueOf = (env: Environment, name: string) => (env[name] === '' ? undefined : env[name]);

/** Basic auth, from the environment alone: the configuration is checked in. */
export function credentialsFrom(env: Environment): Credentials | undefined {
  const username = valueOf(env, USERNAME);
  const password = valueOf(env, PASSWORD);

  if (username === undefined) {
    if (password !== undefined) throw new Error(`${PASSWORD} is set and ${USERNAME} is not; basic auth sends a password only with a username`);

    return undefined;
  }
  if (username.includes(':')) throw new Error(`${USERNAME} holds a colon, which basic auth cannot send in a username`);

  return { username, password: password ?? '' };
}

export const authorization = ({ username, password }: Credentials) => `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

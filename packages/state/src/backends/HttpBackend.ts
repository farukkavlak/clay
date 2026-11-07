import { emptyState, State } from '@clay/contracts';
import { createHash } from 'node:crypto';

import { LockInfo, lockInfoFrom, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { authorization, Credentials, PASSWORD, USERNAME } from './httpCredentials';

export interface HttpSettings {
  readonly address: URL;
  readonly updateMethod: string;
  readonly lockAddress: URL;
  readonly lockMethod: string;
  readonly unlockAddress: URL;
  readonly unlockMethod: string;
  readonly credentials?: Credentials;
}

interface Answer {
  readonly status: number;
  readonly body: string;
  /** Where a redirect points. */
  readonly location: string | null;
}

/** A request the server gave no answer to, or no whole one, so whether it acted is not known. */
export class NoAnswer extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'NoAnswer';
  }
}

interface Outgoing {
  readonly method: string;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
}

const GET: Outgoing = { method: 'GET', headers: {} };

/** The body goes with a digest, so a server can refuse one cut short on the way. */
function withBody(method: string, body: string): Outgoing {
  const digest = createHash('md5').update(body, 'utf8').digest('base64');
  return { method, body, headers: { 'Content-Type': 'application/json', 'Content-MD5': digest } };
}

/** fetch throws a TypeError for a connection that failed, with the reason as its cause. */
function reason(error: TypeError): string {
  const { code, message } = (error.cause ?? error) as NodeJS.ErrnoException;
  return code ?? message;
}

/**
 * No redirect is followed: fetch would send a POST on as a GET, and a 200 for that would count as written or locked.
 * The body is read apart, so one cut off after the status is not taken for no answer.
 */
async function send(url: URL, request: Outgoing): Promise<Answer> {
  const { method } = request;
  let response: Response;
  try {
    response = await fetch(url, { ...request, redirect: 'manual' });
  } catch (error) {
    if (error instanceof TypeError) throw new NoAnswer(`${method} ${url.href} got no answer (${reason(error)})`, error);

    throw error;
  }

  try {
    return { status: response.status, body: await response.text(), location: response.headers.get('location') };
  } catch (error) {
    if (error instanceof TypeError) throw new NoAnswer(`${method} ${url.href} answered ${response.status}, but the body was cut off (${reason(error)})`, error);

    throw error;
  }
}

function unexpectedAnswer(method: string, url: URL, { status, location }: Answer, withCredentials: boolean): Error {
  const at = `${method} ${url.href} answered ${status}`;
  if (status === 401 && withCredentials) return new Error(`${at}: the server refuses the credentials in ${USERNAME} and ${PASSWORD}`);
  if (status === 401) return new Error(`${at}: the server asks for credentials; give them in ${USERNAME} and ${PASSWORD}`);
  if (status === 403) return new Error(`${at}: the server refuses this request`);
  if (status >= 300 && status < 400) return new Error(`${at}${location ? ` to ${location}` : ''}; Clay follows no redirect, so the address must name where the server answers`);

  return new Error(at);
}

/** What a write, a lock or an unlock the server took answers. */
const DONE = new Set([200, 201, 204]);

/** The state is one document at one address. A server with no journal gets it whole on every write. */
export class HttpBackend implements StateBackend {
  readonly choice: BackendChoice;
  /** What the lock was taken with, which the unlock sends back. */
  private held: { readonly id: string; readonly body: string } | undefined;
  /** Sent with every request, the lock's among them. */
  private readonly authorization: string | undefined;

  constructor(private readonly settings: HttpSettings) {
    const { address, updateMethod, lockAddress, lockMethod, unlockAddress, unlockMethod, credentials } = settings;
    this.authorization = credentials && authorization(credentials);
    this.choice = {
      type: 'http',
      where: address.href,
      settings: {
        address: address.href,
        update_method: updateMethod,
        lock_address: lockAddress.href,
        lock_method: lockMethod,
        unlock_address: unlockAddress.href,
        unlock_method: unlockMethod,
      },
    };
  }

  get location(): string {
    return this.settings.address.href;
  }

  async check(): Promise<void> {
    await this.stateText();
  }

  async exists(): Promise<boolean> {
    return (await this.stateText()) !== undefined;
  }

  async read(): Promise<State> {
    const text = await this.stateText();
    return text === undefined ? emptyState() : parseState(text, this.location);
  }

  /** The lock's id goes with it, so a server can refuse a write from a run that does not hold the lock. */
  async write(state: State): Promise<void> {
    const { address, updateMethod } = this.settings;
    const url = new URL(address);
    if (this.held) url.searchParams.set('ID', this.held.id);

    const answer = await this.send(url, withBody(updateMethod, serializeState(state)));
    if (!DONE.has(answer.status)) throw this.unexpected(updateMethod, url, answer);
  }

  /** Called under the lock, since the server cannot write only where nothing is. */
  async writeIfAbsent(state: State): Promise<boolean> {
    if (await this.exists()) return false;

    await this.write(state);
    return true;
  }

  async lock(info: LockInfo): Promise<void> {
    const { lockAddress, lockMethod, unlockAddress, unlockMethod } = this.settings;
    const body = JSON.stringify(info);
    const free = `send ${unlockMethod} to ${unlockAddress.href} with what the lock holds`;

    const answer = await this.asked(this.send(lockAddress, withBody(lockMethod, body)), info.id, free);
    if (answer.status === 409 || answer.status === 423) throw new StateLocked(lockInfoFrom(answer.body), free);
    if (!DONE.has(answer.status)) throw this.unexpected(lockMethod, lockAddress, answer);

    this.held = { id: info.id, body };
  }

  /** A lock request with no whole answer may have been taken all the same, and no run would release it. */
  private async asked(sent: Promise<Answer>, id: string, free: string): Promise<Answer> {
    try {
      return await sent;
    } catch (error) {
      if (error instanceof NoAnswer) throw new Error(`${error.message}. The server may hold lock ${id} all the same; if it does, ${free}`, { cause: error });

      throw error;
    }
  }

  /** Sends back what the lock was taken with, as a server that keeps it compares the two. */
  async unlock(id: string): Promise<void> {
    const { unlockAddress, unlockMethod } = this.settings;
    if (this.held?.id !== id) throw new Error(`This run holds no lock ${id} on ${unlockAddress.href}, so it releases none`);

    const answer = await this.send(unlockAddress, withBody(unlockMethod, this.held.body));
    if (!DONE.has(answer.status)) throw this.unexpected(unlockMethod, unlockAddress, answer);

    this.held = undefined;
  }

  /** The body of a 200, or undefined where the server holds no state, which 204, 404 and an empty body all say. */
  private async stateText(): Promise<string | undefined> {
    const { address } = this.settings;
    const answer = await this.send(address, GET);
    if (answer.status === 204 || answer.status === 404) return undefined;
    if (answer.status !== 200) throw this.unexpected('GET', address, answer);

    return answer.body === '' ? undefined : answer.body;
  }

  private send(url: URL, request: Outgoing): Promise<Answer> {
    if (this.authorization === undefined) return send(url, request);

    return send(url, { ...request, headers: { ...request.headers, Authorization: this.authorization } });
  }

  private unexpected(method: string, url: URL, answer: Answer): Error {
    return unexpectedAnswer(method, url, answer, this.authorization !== undefined);
  }
}

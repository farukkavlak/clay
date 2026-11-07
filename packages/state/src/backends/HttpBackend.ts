import { emptyState, State } from '@clay/contracts';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { LockInfo, lockInfoFrom, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { authorization, Credentials, PASSWORD, USERNAME } from './httpCredentials';
import { NoAnswer, Outgoing, Reply, Roots, Tls, trusted, tryOnce } from './httpRequest';
import { askedWait, backoff, passing, Retry } from './httpRetry';
import { CaFile, ClientCertificate } from './httpTls';

export interface HttpSettings {
  readonly address: URL;
  readonly updateMethod: string;
  readonly lockAddress: URL;
  readonly lockMethod: string;
  readonly unlockAddress: URL;
  readonly unlockMethod: string;
  readonly credentials?: Credentials;
  readonly retry: Retry;
  /** Trusted in place of the CAs Node and the system bring. */
  readonly ca?: CaFile;
  readonly client?: ClientCertificate;
}

interface Answer extends Reply {
  /** The last of them gave this answer. */
  readonly tries: number;
}

export type Sleep = (ms: number) => Promise<void>;

const GET: Outgoing = { method: 'GET', headers: {} };

/** The body goes with a digest, so a server can refuse one cut short on the way. */
function withBody(method: string, body: string): Outgoing {
  const digest = createHash('md5').update(body, 'utf8').digest('base64');
  return { method, body, headers: { 'Content-Type': 'application/json', 'Content-MD5': digest } };
}

/** Undefined where the request is not tried again: the tries are used up, another would be answered the same, or the server asks for a longer wait than the longest. */
function waitAfter(retry: Retry, tried: number, reply: Reply | NoAnswer, now: number): number | undefined {
  if (tried > retry.max) return undefined;
  if (reply instanceof NoAnswer) return backoff(retry, tried);
  if (!passing(reply.status)) return undefined;

  const asked = askedWait(reply.retryAfter, now);
  if (asked === undefined) return backoff(retry, tried);
  return asked <= retry.waitMax ? asked : undefined;
}

const triedOf = (tries: number) => (tries > 1 ? ` after ${tries} tries` : '');

function why({ status, location }: Answer, withCredentials: boolean): string {
  if (status === 401 && withCredentials) return `: the server refuses the credentials in ${USERNAME} and ${PASSWORD}`;
  if (status === 401) return `: the server asks for credentials; give them in ${USERNAME} and ${PASSWORD}`;
  if (status === 403) return ': the server refuses this request';
  if (status >= 300 && status < 400) return `${location ? ` to ${location}` : ''}; Clay follows no redirect, so the address must name where the server answers`;

  return '';
}

function unexpectedAnswer(method: string, url: URL, answer: Answer, withCredentials: boolean): Error {
  const asked = answer.retryAfter === null ? '' : `; it asks to be tried again after ${answer.retryAfter}`;

  return new Error(`${method} ${url.href} answered ${answer.status}${triedOf(answer.tries)}${why(answer, withCredentials)}${asked}`);
}

function settled(reply: Reply | NoAnswer, tries: number): Answer {
  if (reply instanceof NoAnswer) throw new NoAnswer(`${reply.message}${triedOf(tries)}`, reply.cause);

  return { ...reply, tries };
}

const mayHold = (id: string, free: string) => `The server may hold lock ${id} all the same; if it does, ${free}`;

/** What a write, a lock or an unlock the server took answers. */
const DONE = new Set([200, 201, 204]);

/** The state is one document at one address. A server with no journal gets it whole on every write. */
export class HttpBackend implements StateBackend {
  readonly choice: BackendChoice;
  /** What the lock was taken with, which the unlock sends back. */
  private held: { readonly id: string; readonly body: string } | undefined;
  /** Sent with every request, the lock's among them. */
  private readonly authorization: string | undefined;
  private readonly tls: Tls;

  constructor(
    private readonly settings: HttpSettings,
    private readonly sleep: Sleep = delay,
    roots: Roots = trusted()
  ) {
    const { address, updateMethod, lockAddress, lockMethod, unlockAddress, unlockMethod, credentials, retry, ca, client } = settings;
    this.authorization = credentials && authorization(credentials);
    this.tls = { ca: ca?.roots ?? roots, caFile: ca?.name, client };
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
        retry_max: retry.max,
        retry_wait_min: retry.waitMin,
        retry_wait_max: retry.waitMax,
        timeout: retry.timeout,
        ...(ca && { ca_certificate: ca.name }),
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
    if (!DONE.has(answer.status) && !this.ownLock(answer, info.id)) {
      if (answer.status === 409 || answer.status === 423) throw new StateLocked(lockInfoFrom(answer.body), free);

      const error = this.unexpected(lockMethod, lockAddress, answer);
      throw answer.tries === 1 ? error : new Error(`${error.message}. ${mayHold(info.id, free)}`);
    }

    this.held = { id: info.id, body };
  }

  /** A try the server took, and whose answer was lost, has the lock held by this run's own id when the next try comes. */
  private ownLock(answer: Answer, id: string): boolean {
    return (answer.status === 409 || answer.status === 423) && lockInfoFrom(answer.body)?.id === id;
  }

  /** A lock request with no whole answer may have been taken all the same, and no run would release it. */
  private async asked(sent: Promise<Answer>, id: string, free: string): Promise<Answer> {
    try {
      return await sent;
    } catch (error) {
      if (error instanceof NoAnswer) throw new Error(`${error.message}. ${mayHold(id, free)}`, { cause: error });

      throw error;
    }
  }

  /** Sends back what the lock was taken with, as a server that keeps it compares the two. */
  async unlock(id: string): Promise<void> {
    const { unlockAddress, unlockMethod } = this.settings;
    if (this.held?.id !== id) throw new Error(`This run holds no lock ${id} on ${unlockAddress.href}, so it releases none`);

    const answer = await this.send(unlockAddress, withBody(unlockMethod, this.held.body));
    if (!DONE.has(answer.status)) {
      const error = this.unexpected(unlockMethod, unlockAddress, answer);
      if (answer.tries === 1) throw error;

      throw new Error(`${error.message}. A try before it may have released lock ${id} all the same`);
    }

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

  /** A try with no answer is taken again too: a write sent twice writes the same, and a lock a lost try took is known by its id. */
  private async send(url: URL, request: Outgoing): Promise<Answer> {
    const { retry } = this.settings;
    const outgoing = this.authorization === undefined ? request : { ...request, headers: { ...request.headers, Authorization: this.authorization } };

    for (let tried = 1; ; tried += 1) {
      const reply = await tryOnce(url, outgoing, retry.timeout, this.tls);
      const wait = waitAfter(retry, tried, reply, Date.now());
      if (wait === undefined) return settled(reply, tried);

      await this.sleep(wait * 1000);
    }
  }

  private unexpected(method: string, url: URL, answer: Answer): Error {
    return unexpectedAnswer(method, url, answer, this.authorization !== undefined);
  }
}

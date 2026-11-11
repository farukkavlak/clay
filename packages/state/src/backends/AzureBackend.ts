// The SDK is loaded with import(), which takes its ESM build; its types have to come from the same build.
import type { ContainerClient, RestError } from '@azure/storage-blob' with { 'resolution-mode': 'import' };
import { emptyState, State } from '@clay/contracts';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';

import { LockInfo, lockInfoFrom, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { NoAnswer } from './httpRequest';
import { passing } from './httpRetry';

type Sdk = typeof import('@azure/storage-blob', { with: { 'resolution-mode': 'import' } });

export const ACCOUNT_KEY = 'AZURE_STORAGE_KEY';
export const SAS_TOKEN = 'AZURE_STORAGE_SAS_TOKEN';

/** A shared key signs each request, a SAS token is sent with each, and Entra ID gives a token for the identity the machine is signed in as. */
export type AzureCredential = { readonly accountKey: string } | { readonly sasToken: string } | { readonly entraId: true };

export interface AzureSettings {
  readonly account: string;
  readonly container: string;
  readonly key: string;
  /** Unset for Azure itself. */
  readonly endpoint?: URL;
  readonly credential: AzureCredential;
}

/** How long a try may take and how often a request is sent in all, and the wait before the second try, doubled after each. */
export interface AzureLimits {
  readonly timeout: number;
  readonly attempts: number;
  readonly wait: number;
}

const LIMITS: AzureLimits = { timeout: 30, attempts: 3, wait: 1 };

interface Stored {
  readonly text: string;
  readonly etag: string | undefined;
}

/** What Azure answered, or the error it answered with and after how many tries. */
type Outcome<T> = { readonly output: T; readonly refused?: undefined } | { readonly refused: RestError; readonly tried: number };

type Refused = Extract<Outcome<unknown>, { readonly tried: number }>;

/** One try: an answer, or why none came. */
type Attempt<T> = Outcome<T> | { readonly lost: string; readonly cause: unknown };

type Request<T> = (container: ContainerClient, abortSignal: AbortSignal) => Promise<T>;

interface Connection {
  readonly sdk: Sdk;
  readonly container: ContainerClient;
}

/** Azure answers a write where a blob is with 409, and a server that keeps to the header alone with 412. */
const isTaken = (refused: RestError) => refused.code === 'BlobAlreadyExists' || refused.code === 'ConditionNotMet';

/** The errors Entra ID signs in with, which come before any request is sent. */
const SIGN_IN = new Set(['AggregateAuthenticationError', 'AuthenticationError', 'CredentialUnavailableError']);

const isSignIn = (error: unknown): error is Error => error instanceof Error && SIGN_IN.has(error.name);

/** Only a missing blob is no state; a missing container is an error. */
const isMissing = (refused: RestError) => refused.code === 'BlobNotFound';

const triedOf = (tried: number) => (tried > 1 ? ` after ${tried} tries` : '');

/** Azure's own address, or the endpoint's, with no "/" at the end. */
const baseOf = ({ account, endpoint }: AzureSettings) => (endpoint === undefined ? `https://${account}.blob.core.windows.net` : endpoint.href.replace(/\/$/, ''));

/** The SDK sends a request once, as each try is timed here. Entra ID is loaded only where it signs in. */
async function containerOf(sdk: Sdk, settings: AzureSettings): Promise<ContainerClient> {
  const { credential } = settings;
  const url = `${baseOf(settings)}/${settings.container}`;
  const options = { retryOptions: { maxTries: 1 } };
  if ('accountKey' in credential) return new sdk.ContainerClient(url, new sdk.StorageSharedKeyCredential(settings.account, credential.accountKey), options);
  if ('sasToken' in credential) return new sdk.ContainerClient(`${url}?${credential.sasToken}`, new sdk.AnonymousCredential(), options);

  const { DefaultAzureCredential } = await import('@azure/identity');
  return new sdk.ContainerClient(url, new DefaultAzureCredential(), options);
}

/** The state is one blob, and its lock another beside it, written only where none is. */
export class AzureBackend implements StateBackend {
  readonly choice: BackendChoice;
  readonly location: string;
  private readonly lockKey: string;
  private readonly lockLocation: string;
  private connection: Promise<Connection> | undefined;

  constructor(
    private readonly settings: AzureSettings,
    private readonly limits: AzureLimits = LIMITS
  ) {
    const { account, container, key, endpoint } = settings;
    this.location = `${baseOf(settings)}/${container}/${key}`;
    this.lockKey = `${key}.lock`;
    this.lockLocation = `${this.location}.lock`;
    this.choice = {
      type: 'azure',
      where: this.location,
      settings: { storage_account_name: account, container_name: container, key, ...(endpoint && { endpoint: endpoint.href }) },
    };
  }

  async check(): Promise<void> {
    await this.stored(this.settings.key);
  }

  async exists(): Promise<boolean> {
    return (await this.stored(this.settings.key)) !== undefined;
  }

  async read(): Promise<State> {
    const stored = await this.stored(this.settings.key);
    return stored === undefined ? emptyState() : parseState(stored.text, this.location);
  }

  async write(state: State): Promise<void> {
    const outcome = await this.put(this.settings.key, serializeState(state), false);
    if (outcome.refused) throw this.unexpected('PutBlob', this.location, outcome);
  }

  /** Azure writes only where no blob is, so no other run can write in between. */
  async writeIfAbsent(state: State): Promise<boolean> {
    const outcome = await this.put(this.settings.key, serializeState(state), true);
    if (outcome.refused && isTaken(outcome.refused)) return false;
    if (outcome.refused) throw this.unexpected('PutBlob', this.location, outcome);

    return true;
  }

  /** A lock released between the refusal and the read is tried once more. */
  async lock(info: LockInfo): Promise<void> {
    const free = `delete ${this.lockLocation}`;
    let held = await this.heldBy(info, free);
    if (held === 'gone') held = await this.heldBy(info, free);
    if (held === 'taken') return;

    throw new StateLocked(held === 'gone' ? undefined : held, free);
  }

  /** A try sent again, after the answer to one Azure took was lost, finds the lock held by this run's own id. */
  private async heldBy(info: LockInfo, free: string): Promise<'taken' | 'gone' | LockInfo | undefined> {
    const outcome = await this.putLock(info, free);
    if (!outcome.refused) return 'taken';
    if (!isTaken(outcome.refused)) throw this.unexpected('PutBlob', this.lockLocation, outcome);

    const stored = await this.stored(this.lockKey);
    if (stored === undefined) return 'gone';

    const holder = lockInfoFrom(stored.text);
    return holder?.id === info.id ? 'taken' : holder;
  }

  /** A lock request with no answer may have been taken all the same, and no run would release it. */
  private async putLock(info: LockInfo, free: string): Promise<Outcome<unknown>> {
    try {
      return await this.put(this.lockKey, JSON.stringify(info), true);
    } catch (error) {
      if (error instanceof NoAnswer) throw new Error(`${error.message}. Azure may hold lock ${info.id} all the same; if it does, ${free}`, { cause: error });

      throw error;
    }
  }

  /** A delete the lock changed under is answered 404 or 412, so the lock read again decides. */
  async unlock(id: string): Promise<void> {
    const refused = await this.releaseOwn(id);
    if (refused === undefined) return;

    const again = await this.releaseOwn(id);
    if (again !== undefined) throw this.unexpected('DeleteBlob', this.lockLocation, again);
  }

  /** Undefined where the lock is gone now, or the refusal of a delete the lock may have changed under. */
  private async releaseOwn(id: string): Promise<Refused | undefined> {
    const stored = await this.stored(this.lockKey);
    if (stored === undefined) return undefined;
    if (lockInfoFrom(stored.text)?.id !== id) throw new Error(`${this.lockLocation} holds a lock this run did not take, so it is left in place`);

    const outcome = await this.send('DeleteBlob', this.lockLocation, (container, abortSignal) =>
      container.getBlockBlobClient(this.lockKey).delete({ abortSignal, conditions: { ifMatch: stored.etag } })
    );
    if (!outcome.refused) return undefined;
    if (!isMissing(outcome.refused) && outcome.refused.code !== 'ConditionNotMet') throw this.unexpected('DeleteBlob', this.lockLocation, outcome);

    return outcome;
  }

  /** Undefined where no blob is, or an empty one. */
  private async stored(key: string): Promise<Stored | undefined> {
    const at = key === this.lockKey ? this.lockLocation : this.location;
    const outcome = await this.send('GetBlob', at, async (container, abortSignal) => {
      const answer = await container.getBlockBlobClient(key).download(0, undefined, { abortSignal });
      return { text: answer.readableStreamBody === undefined ? '' : await text(answer.readableStreamBody), etag: answer.etag };
    });
    if (outcome.refused && isMissing(outcome.refused)) return undefined;
    if (outcome.refused) throw this.unexpected('GetBlob', at, outcome);

    return outcome.output.text === '' ? undefined : outcome.output;
  }

  private put(key: string, body: string, onlyIfAbsent: boolean): Promise<Outcome<unknown>> {
    const at = key === this.lockKey ? this.lockLocation : this.location;
    return this.send('PutBlob', at, (container, abortSignal) =>
      container.getBlockBlobClient(key).upload(body, Buffer.byteLength(body, 'utf8'), {
        abortSignal,
        blobHTTPHeaders: { blobContentType: 'application/json' },
        ...(onlyIfAbsent && { conditions: { ifNoneMatch: '*' } }),
      })
    );
  }

  /** No answer, a 429 or a 5xx is tried again; an error Azure answered at the last try is handed back, and no answer is thrown. */
  private async send<T>(operation: string, at: string, request: Request<T>): Promise<Outcome<T>> {
    const connection = await this.connected();
    for (let tried = 1; ; tried += 1) {
      const attempt = await this.attempt(connection, request, tried, `${operation} ${at}`);
      const passes = 'lost' in attempt || (attempt.refused !== undefined && passing(attempt.refused.statusCode ?? 0));
      if (!passes || tried === this.limits.attempts) {
        if ('lost' in attempt) throw new NoAnswer(`${operation} ${at} got no answer (${attempt.lost})${triedOf(tried)}`, attempt.cause);

        return attempt;
      }

      await sleep(this.limits.wait * 1000 * 2 ** (tried - 1));
    }
  }

  /** The SDK answers a refusal with a status, and a request that got no answer with none. */
  private async attempt<T>({ sdk, container }: Connection, request: Request<T>, tried: number, asked: string): Promise<Attempt<T>> {
    const abortSignal = AbortSignal.timeout(this.limits.timeout * 1000);
    try {
      return { output: await request(container, abortSignal) };
    } catch (error) {
      if (abortSignal.aborted) return { lost: `timed out after ${this.limits.timeout}s`, cause: error };
      if (isSignIn(error))
        throw new Error(`${asked} could not sign in with Entra ID, which is used where neither ${ACCOUNT_KEY} nor ${SAS_TOKEN} is set:\n${error.message}`, {
          cause: error,
        });
      if (!(error instanceof sdk.RestError)) throw error;

      return error.statusCode === undefined ? { lost: error.code ?? error.message, cause: error } : { refused: error, tried };
    }
  }

  /** The SDK is loaded by the first request, so a run with no Azure backend never loads it. */
  private async connected(): Promise<Connection> {
    this.connection ??= import('@azure/storage-blob').then(async (sdk) => ({ sdk, container: await containerOf(sdk, this.settings) }));
    return this.connection;
  }

  /** Azure refuses an identity with no data role as it refuses a SAS token without the permission. */
  private unexpected(operation: string, at: string, { refused, tried }: Refused): Error {
    const message = refused.message.replaceAll('\n', ' ');
    const role =
      'entraId' in this.settings.credential && refused.code === 'AuthorizationPermissionMismatch'
        ? `; the signed-in identity needs a data role on the container, such as Storage Blob Data Contributor`
        : '';
    return new Error(`${operation} ${at} answered ${refused.statusCode} ${refused.code ?? 'with no code'}${triedOf(tried)}: ${message}${role}`, { cause: refused });
  }
}

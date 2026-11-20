// The SDK is loaded with import(), which takes its ESM build; its types have to come from the same build.
import type { ContainerClient, ContainerListBlobFlatSegmentResponse, RestError } from '@azure/storage-blob' with { 'resolution-mode': 'import' };
import { emptyState, State, WrittenState } from '@clay/core';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';

import { forceUnlockWith, LockInfo, lockInfoFrom, noLockAt, otherLockAt, StateLocked } from '../lockInfo';
import { BackendChoice, DEFAULT_WORKSPACE, NamedWorkspace } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { NoAnswer } from './httpRequest';
import { passing } from './httpRetry';
import { refuseIfGone, workspaceKey, workspaceOfKey, workspacesPrefix } from './workspaces';

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

export const LONGEST_BLOB_NAME = 1024;

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

/** The state is one blob, and its lock another beside it, written only where none is. A named workspace has one of each of its own. */
export class AzureBackend implements NamedWorkspace {
  readonly choice: BackendChoice;
  readonly location: string;
  private readonly stateKey: string;
  private readonly lockKey: string;
  private readonly lockLocation: string;
  private readonly listLocation: string;
  /** Set by `prepare`, as `workspace new` makes the workspace whose lock it then takes. */
  private making = false;
  private connection: Promise<Connection> | undefined;

  constructor(
    private readonly settings: AzureSettings,
    private readonly limits: AzureLimits = LIMITS,
    private readonly workspaceName: string = DEFAULT_WORKSPACE
  ) {
    const { account, container, key, endpoint } = settings;
    const place = `${baseOf(settings)}/${container}`;
    this.stateKey = workspaceKey(key, workspaceName);
    this.location = `${place}/${this.stateKey}`;
    this.lockKey = `${this.stateKey}.lock`;
    this.lockLocation = `${this.location}.lock`;
    this.listLocation = `${place}/${workspacesPrefix(key)}`;
    this.choice = {
      type: 'azure',
      where: `${place}/${key}`,
      settings: { storage_account_name: account, container_name: container, key, ...(endpoint && { endpoint: endpoint.href }) },
    };
  }

  workspace(name: string): AzureBackend {
    return new AzureBackend(this.settings, this.limits, name);
  }

  /** Every blob is listed, so finding the workspaces takes no request for each. An empty blob is no state, as `exists` reads it. */
  async listWorkspaces(): Promise<string[]> {
    const named: string[] = [];
    let marker: string | undefined;
    do {
      const page = await this.listed(marker);
      for (const { name, properties } of page.segment.blobItems) {
        const workspace = properties.contentLength === 0 ? undefined : workspaceOfKey(this.settings.key, name);
        if (workspace !== undefined) named.push(workspace);
      }
      marker = page.continuationToken === '' ? undefined : page.continuationToken;
    } while (marker !== undefined);

    return [DEFAULT_WORKSPACE, ...named.sort()];
  }

  private async listed(marker: string | undefined): Promise<ContainerListBlobFlatSegmentResponse> {
    const outcome = await this.send('ListBlobs', this.listLocation, async (container, abortSignal) => {
      const pages = container.listBlobsFlat({ prefix: workspacesPrefix(this.settings.key), abortSignal }).byPage({ continuationToken: marker });
      const { value } = await pages.next();
      return value as ContainerListBlobFlatSegmentResponse;
    });
    if (!outcome.refused) return outcome.output;
    if (outcome.refused.code === 'AuthorizationPermissionMismatch')
      throw new Error(
        `Azure refused to list ${this.listLocation}; finding workspaces needs permission to list the blobs of container "${this.settings.container}": "l" in a SAS token, or a data role such as Storage Blob Data Reader`,
        { cause: outcome.refused }
      );

    throw this.unexpected('ListBlobs', this.listLocation, outcome);
  }

  /** A blob is written with its folders, so only the length of the lock's name is left to check. */
  async prepare(): Promise<void> {
    if (this.workspaceName === DEFAULT_WORKSPACE) return;

    const { length } = this.lockKey;
    if (length > LONGEST_BLOB_NAME)
      throw new Error(
        `The lock of workspace "${this.workspaceName}" would have a name of ${length} characters, and Azure takes ${LONGEST_BLOB_NAME} at most; use a shorter key in the backend block`
      );

    this.making = true;
  }

  async remove(): Promise<void> {
    if (this.workspaceName === DEFAULT_WORKSPACE) throw new Error('The state of the default workspace is not removed');

    const outcome = await this.send('DeleteBlob', this.location, (container, abortSignal) => container.getBlockBlobClient(this.stateKey).delete({ abortSignal }));
    if (outcome.refused && !isMissing(outcome.refused)) throw this.unexpected('DeleteBlob', this.location, outcome);
  }

  /** An empty folder that an account with a hierarchical namespace keeps is not listed as a workspace. */
  async prune(): Promise<void> {}

  async check(): Promise<void> {
    await this.stored(this.stateKey);
  }

  async exists(): Promise<boolean> {
    return (await this.stored(this.stateKey)) !== undefined;
  }

  async read(): Promise<State> {
    const stored = await this.stored(this.stateKey);
    if (stored !== undefined) return parseState(stored.text, this.location);
    if (this.mustExist) throw this.missing();

    return emptyState();
  }

  async write(state: WrittenState): Promise<void> {
    const outcome = await this.put(this.stateKey, serializeState(state), false);
    if (outcome.refused) throw this.unexpected('PutBlob', this.location, outcome);
  }

  /**
   * Azure writes only where no blob is, so no other run can write in between. What it refuses is read: the same text is this write, taken
   * by a try whose answer was lost and found by the try sent again, and an empty blob is no state.
   */
  async writeIfAbsent(state: WrittenState): Promise<boolean> {
    const body = serializeState(state);
    const outcome = await this.put(this.stateKey, body, true);
    if (!outcome.refused) return true;
    if (!isTaken(outcome.refused)) throw this.unexpected('PutBlob', this.location, outcome);

    const stored = await this.stored(this.stateKey);
    if (stored !== undefined) return stored.text === body;

    await this.write(state);
    return true;
  }

  /** A lock released between the refusal and the read is tried once more. A named workspace deleted while this run waited is refused. */
  async lock(info: LockInfo): Promise<void> {
    let held = await this.heldBy(info);
    if (held === 'gone') held = await this.heldBy(info);
    if (held !== 'taken') throw new StateLocked(held === 'gone' ? undefined : held, `delete ${this.lockLocation}`);
    if (this.mustExist) await refuseIfGone(this, info.id, () => this.missing());
  }

  /** A named workspace has a state, but where `workspace new` is making it; the default one runs without. */
  private get mustExist(): boolean {
    return this.workspaceName !== DEFAULT_WORKSPACE && !this.making;
  }

  private missing(): Error {
    return new Error(`Workspace "${this.workspaceName}" does not exist`);
  }

  /** A try sent again, after the answer to one Azure took was lost, finds the lock held by this run's own id. */
  private async heldBy(info: LockInfo): Promise<'taken' | 'gone' | LockInfo | undefined> {
    const outcome = await this.putLock(info);
    if (!outcome.refused) return 'taken';
    if (!isTaken(outcome.refused)) throw this.unexpected('PutBlob', this.lockLocation, outcome);

    const stored = await this.stored(this.lockKey);
    if (stored === undefined) return 'gone';

    const holder = lockInfoFrom(stored.text);
    return holder?.id === info.id ? 'taken' : holder;
  }

  /** A lock request with no answer may have been taken all the same, and no run would release it. */
  private async putLock(info: LockInfo): Promise<Outcome<unknown>> {
    try {
      return await this.put(this.lockKey, JSON.stringify(info), true);
    } catch (error) {
      if (error instanceof NoAnswer) throw new Error(`${error.message}. Azure may hold lock ${info.id} all the same; if it does, ${forceUnlockWith(info.id)}`, { cause: error });

      throw error;
    }
  }

  async unlock(id: string): Promise<void> {
    await this.release(id, () => new Error(`${this.lockLocation} holds a lock this run did not take, so it is left in place`));
  }

  async forceUnlock(id: string): Promise<void> {
    const found = await this.release(id, (holder) => otherLockAt(this.lockLocation, holder, id));
    if (!found) throw noLockAt(this.lockLocation);
  }

  /** A delete the lock changed under is answered 404 or 412, so the lock read again decides. */
  private async release(id: string, other: (holder: LockInfo | undefined) => Error): Promise<boolean> {
    const first = await this.deleteHeldBy(id, other);
    if (first === 'none') return false;
    if (first === 'deleted') return true;

    const again = await this.deleteHeldBy(id, other);
    if (again !== 'none' && again !== 'deleted') throw this.unexpected('DeleteBlob', this.lockLocation, again);
    return true;
  }

  /** The refusal of a delete the lock may have changed under, or what was there to delete. */
  private async deleteHeldBy(id: string, other: (holder: LockInfo | undefined) => Error): Promise<'none' | 'deleted' | Refused> {
    const stored = await this.stored(this.lockKey);
    if (stored === undefined) return 'none';

    const holder = lockInfoFrom(stored.text);
    if (holder?.id !== id) throw other(holder);

    const outcome = await this.send('DeleteBlob', this.lockLocation, (container, abortSignal) =>
      container.getBlockBlobClient(this.lockKey).delete({ abortSignal, conditions: { ifMatch: stored.etag } })
    );
    if (!outcome.refused) return 'deleted';
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

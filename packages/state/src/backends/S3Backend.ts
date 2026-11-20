import type { ListObjectsV2CommandOutput, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { emptyState, State, WrittenState } from '@clay/core';

import { forceUnlockWith, LockInfo, lockInfoFrom, noLockAt, otherLockAt, StateLocked } from '../lockInfo';
import { BackendChoice, DEFAULT_WORKSPACE, NamedWorkspace } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { NoAnswer } from './httpRequest';
import { refuseIfGone, workspaceKey, workspaceOfKey, workspacesPrefix } from './workspaces';

type Sdk = typeof import('@aws-sdk/client-s3');

export interface S3Settings {
  readonly bucket: string;
  readonly key: string;
  readonly region: string;
  /** False where the region came from the environment, which `init` does not record. */
  readonly regionInBlock: boolean;
  /** Unset for AWS itself. */
  readonly endpoint?: URL;
  /** The bucket in the path, not in the host name, as most servers other than AWS want it. */
  readonly pathStyle: boolean;
}

/** How long a request may take, and how often it is sent in all. */
export interface S3Limits {
  readonly timeout: number;
  readonly attempts: number;
}

const LIMITS: S3Limits = { timeout: 30, attempts: 3 };

/** In bytes of UTF-8. */
export const LONGEST_S3_KEY = 1024;

interface Stored {
  readonly text: string;
  readonly etag: string | undefined;
}

/** What S3 answered, or the error it answered with. */
type Outcome<T> = { readonly output: T; readonly refused?: undefined } | { readonly refused: S3ServiceException };

const statusOf = (refused: S3ServiceException) => refused.$metadata.httpStatusCode;

/** Only a missing key is no state; a missing bucket is an error. */
const isMissing = (refused: S3ServiceException) => refused.name === 'NoSuchKey';

const triedOf = (tries: number | undefined) => (tries !== undefined && tries > 1 ? ` after ${tries} tries` : '');

/** Why a request got no answer, from the system's error code or the SDK's timeout, and how often the SDK tried it. */
function noAnswerOf(error: unknown, timeout: number): { readonly why: string; readonly tries: number | undefined } | undefined {
  if (!(error instanceof Error)) return undefined;

  const tries = '$metadata' in error ? (error.$metadata as { attempts?: number }).attempts : undefined;
  // The SDK names a reset connection a TimeoutError too, with its code; a connection it gave up on has none.
  const { code } = error as NodeJS.ErrnoException;
  if (code === 'ETIMEDOUT' || (code === undefined && error.name === 'TimeoutError')) return { why: `timed out after ${timeout}s`, tries };
  if (typeof code === 'string') return { why: code, tries };

  return undefined;
}

/** The state is one object, and its lock another beside it, taken only where none is. A named workspace has one of each of its own. */
export class S3Backend implements NamedWorkspace {
  readonly choice: BackendChoice;
  readonly location: string;
  private readonly stateKey: string;
  private readonly lockKey: string;
  private readonly lockLocation: string;
  private readonly listLocation: string;
  /** Set by `prepare`, as `workspace new` makes the workspace whose lock it then takes. */
  private making = false;
  private connection: Promise<{ readonly sdk: Sdk; readonly client: S3Client }> | undefined;

  constructor(
    private readonly settings: S3Settings,
    private readonly limits: S3Limits = LIMITS,
    private readonly workspaceName: string = DEFAULT_WORKSPACE
  ) {
    const { bucket, key, region, regionInBlock, endpoint, pathStyle } = settings;
    const at = endpoint === undefined ? '' : ` at ${endpoint.href}`;
    this.stateKey = workspaceKey(key, workspaceName);
    this.location = `s3://${bucket}/${this.stateKey}${at}`;
    this.lockKey = `${this.stateKey}.lock`;
    this.lockLocation = `s3://${bucket}/${this.lockKey}${at}`;
    this.listLocation = `s3://${bucket}/${workspacesPrefix(key)}${at}`;
    this.choice = {
      type: 's3',
      where: `s3://${bucket}/${key}${at}`,
      settings: { bucket, key, ...(regionInBlock && { region }), ...(endpoint && { endpoint: endpoint.href }), use_path_style: pathStyle },
    };
  }

  workspace(name: string): S3Backend {
    return new S3Backend(this.settings, this.limits, name);
  }

  /** Every key is listed, so finding the workspaces takes no request for each. An empty object is no state, as `exists` reads it. */
  async listWorkspaces(): Promise<string[]> {
    const named: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.listed(token);
      for (const { Key, Size } of page.Contents ?? []) {
        const name = Key === undefined || Size === 0 ? undefined : workspaceOfKey(this.settings.key, Key);
        if (name !== undefined) named.push(name);
      }
      token = this.nextToken(page);
    } while (token !== undefined);

    return [DEFAULT_WORKSPACE, ...named.sort()];
  }

  private async listed(token: string | undefined): Promise<ListObjectsV2CommandOutput> {
    const outcome = await this.send('ListObjectsV2', this.listLocation, (sdk, client) =>
      client.send(new sdk.ListObjectsV2Command({ Bucket: this.settings.bucket, Prefix: workspacesPrefix(this.settings.key), ContinuationToken: token }))
    );
    if (!outcome.refused) return outcome.output;
    if (outcome.refused.name === 'AccessDenied')
      throw new Error(`S3 refused to list ${this.listLocation}; finding workspaces needs s3:ListBucket on bucket "${this.settings.bucket}"`, { cause: outcome.refused });

    throw this.unexpected('ListObjectsV2', this.listLocation, outcome.refused);
  }

  /** A list cut short would hide workspaces, and `init` would leave them behind. */
  private nextToken({ IsTruncated, NextContinuationToken }: ListObjectsV2CommandOutput): string | undefined {
    if (!IsTruncated) return undefined;
    if (NextContinuationToken === undefined) throw new Error(`The listing of ${this.listLocation} was cut short with no way to go on`);

    return NextContinuationToken;
  }

  /** S3 has no folders to make, so only the length of the lock's key is left to check. */
  async prepare(): Promise<void> {
    if (this.workspaceName === DEFAULT_WORKSPACE) return;

    const bytes = Buffer.byteLength(this.lockKey, 'utf8');
    if (bytes > LONGEST_S3_KEY)
      throw new Error(
        `The lock of workspace "${this.workspaceName}" would have a key of ${bytes} bytes, and S3 takes ${LONGEST_S3_KEY} at most; use a shorter key in the backend block`
      );

    this.making = true;
  }

  async remove(): Promise<void> {
    if (this.workspaceName === DEFAULT_WORKSPACE) throw new Error('The state of the default workspace is not removed');

    const outcome = await this.send('DeleteObject', this.location, (sdk, client) => client.send(new sdk.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.stateKey })));
    if (outcome.refused && !isMissing(outcome.refused)) throw this.unexpected('DeleteObject', this.location, outcome.refused);
  }

  /** A key leaves no folder behind. */
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
    if (outcome.refused) throw this.unexpected('PutObject', this.location, outcome.refused);
  }

  /**
   * S3 writes only where no object is, so no other run can write in between. What it refuses is read: the same text is this write, taken
   * by a try whose answer was lost and found by the try the SDK sent again, and an empty object is no state.
   */
  async writeIfAbsent(state: WrittenState): Promise<boolean> {
    const text = serializeState(state);
    const outcome = await this.put(this.stateKey, text, true);
    if (!outcome.refused) return true;
    if (statusOf(outcome.refused) !== 412) throw this.unexpected('PutObject', this.location, outcome.refused);

    const stored = await this.stored(this.stateKey);
    if (stored !== undefined) return stored.text === text;

    await this.write(state);
    return true;
  }

  /** A lock released between the refusal and the read is tried once more. A named workspace deleted while this run waited is refused. */
  async lock(info: LockInfo): Promise<void> {
    let held = await this.heldBy(info);
    if (held === 'gone') held = await this.heldBy(info);
    if (held !== 'taken') throw new StateLocked(held === 'gone' ? undefined : held, `remove ${this.lockLocation}`);
    if (this.mustExist) await refuseIfGone(this, info.id, () => this.missing());
  }

  /** A named workspace has a state, but where `workspace new` is making it; the default one runs without. */
  private get mustExist(): boolean {
    return this.workspaceName !== DEFAULT_WORKSPACE && !this.making;
  }

  private missing(): Error {
    return new Error(`Workspace "${this.workspaceName}" does not exist`);
  }

  /** A try the SDK sent again, after the answer to one S3 took was lost, finds the lock held by this run's own id. */
  private async heldBy(info: LockInfo): Promise<'taken' | 'gone' | LockInfo | undefined> {
    const outcome = await this.putLock(info);
    if (!outcome.refused) return 'taken';

    // 409 is another request taking the same lock at the same time.
    const status = statusOf(outcome.refused);
    if (status !== 412 && status !== 409) throw this.unexpected('PutObject', this.lockLocation, outcome.refused);

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
      if (error instanceof NoAnswer) throw new Error(`${error.message}. S3 may hold lock ${info.id} all the same; if it does, ${forceUnlockWith(info.id)}`, { cause: error });

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

  /** Servers answer a delete the lock changed under with 404, 409 or 412 alike, so the lock read again decides. */
  private async release(id: string, other: (holder: LockInfo | undefined) => Error): Promise<boolean> {
    const first = await this.deleteHeldBy(id, other);
    if (first === 'none') return false;
    if (first === 'deleted') return true;

    const again = await this.deleteHeldBy(id, other);
    if (again !== 'none' && again !== 'deleted') throw this.unexpected('DeleteObject', this.lockLocation, again);
    return true;
  }

  /** The refusal of a delete the lock may have changed under, or what was there to delete. */
  private async deleteHeldBy(id: string, other: (holder: LockInfo | undefined) => Error): Promise<'none' | 'deleted' | S3ServiceException> {
    const stored = await this.stored(this.lockKey);
    if (stored === undefined) return 'none';

    const holder = lockInfoFrom(stored.text);
    if (holder?.id !== id) throw other(holder);

    const outcome = await this.send('DeleteObject', this.lockLocation, (sdk, client) =>
      client.send(new sdk.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.lockKey, IfMatch: stored.etag }))
    );
    if (!outcome.refused) return 'deleted';

    const status = statusOf(outcome.refused);
    if (!isMissing(outcome.refused) && status !== 409 && status !== 412) throw this.unexpected('DeleteObject', this.lockLocation, outcome.refused);

    return outcome.refused;
  }

  /** Undefined where no object is, or an empty one. */
  private async stored(key: string): Promise<Stored | undefined> {
    const at = key === this.lockKey ? this.lockLocation : this.location;
    const outcome = await this.send('GetObject', at, async (sdk, client) => {
      const { Body, ETag } = await client.send(new sdk.GetObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      return { text: (await Body?.transformToString('utf8')) ?? '', etag: ETag };
    });
    if (outcome.refused && isMissing(outcome.refused)) return undefined;
    if (outcome.refused) throw this.unexpected('GetObject', at, outcome.refused);

    return outcome.output.text === '' ? undefined : outcome.output;
  }

  private put(key: string, body: string, onlyIfAbsent: boolean): Promise<Outcome<unknown>> {
    const at = key === this.lockKey ? this.lockLocation : this.location;
    return this.send('PutObject', at, (sdk, client) =>
      client.send(new sdk.PutObjectCommand({ Bucket: this.settings.bucket, Key: key, Body: body, ContentType: 'application/json', ...(onlyIfAbsent && { IfNoneMatch: '*' }) }))
    );
  }

  /** An error S3 answered is handed back; one where it gave no answer, or no credentials were found, is thrown. */
  private async send<T>(operation: string, at: string, request: (sdk: Sdk, client: S3Client) => Promise<T>): Promise<Outcome<T>> {
    const { sdk, client } = await this.connected();
    try {
      return { output: await request(sdk, client) };
    } catch (error) {
      if (error instanceof sdk.S3ServiceException) return { refused: error };

      if (error instanceof Error && error.name === 'CredentialsProviderError')
        throw new Error(`${operation} ${at} found no AWS credentials; give them in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, a profile or a role`, { cause: error });

      const failure = noAnswerOf(error, this.limits.timeout);
      if (failure !== undefined) throw new NoAnswer(`${operation} ${at} got no answer (${failure.why})${triedOf(failure.tries)}`, error);

      throw error;
    }
  }

  /** The SDK is loaded by the first request, so a run with no S3 backend never loads it. */
  private connected(): Promise<{ readonly sdk: Sdk; readonly client: S3Client }> {
    this.connection ??= import('@aws-sdk/client-s3').then((sdk) => {
      const { region, endpoint, pathStyle } = this.settings;
      const { timeout, attempts } = this.limits;
      const client = new sdk.S3Client({
        region,
        endpoint: endpoint?.href,
        forcePathStyle: pathStyle,
        maxAttempts: attempts,
        requestHandler: { connectionTimeout: timeout * 1000, requestTimeout: timeout * 1000, throwOnRequestTimeout: true },
      });
      return { sdk, client };
    });

    return this.connection;
  }

  private unexpected(operation: string, at: string, refused: S3ServiceException): Error {
    const { name, message, $metadata } = refused;
    return new Error(`${operation} ${at} answered ${$metadata.httpStatusCode ?? 'with no status'} ${name}${triedOf($metadata.attempts)}: ${message}`, { cause: refused });
  }
}

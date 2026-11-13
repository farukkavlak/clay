import type { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { emptyState, State } from '@clay/contracts';

import { forceUnlockWith, LockInfo, lockInfoFrom, noLockAt, otherLockAt, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
import { parseState, serializeState } from '../stateFile';
import { NoAnswer } from './httpRequest';

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

/** The state is one object, and its lock another beside it, taken only where none is. */
export class S3Backend implements StateBackend {
  readonly choice: BackendChoice;
  readonly location: string;
  private readonly lockKey: string;
  private readonly lockLocation: string;
  private connection: Promise<{ readonly sdk: Sdk; readonly client: S3Client }> | undefined;

  constructor(
    private readonly settings: S3Settings,
    private readonly limits: S3Limits = LIMITS
  ) {
    const { bucket, key, region, regionInBlock, endpoint, pathStyle } = settings;
    const at = endpoint === undefined ? '' : ` at ${endpoint.href}`;
    this.location = `s3://${bucket}/${key}${at}`;
    this.lockKey = `${key}.lock`;
    this.lockLocation = `s3://${bucket}/${this.lockKey}${at}`;
    this.choice = {
      type: 's3',
      where: this.location,
      settings: { bucket, key, ...(regionInBlock && { region }), ...(endpoint && { endpoint: endpoint.href }), use_path_style: pathStyle },
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
    if (outcome.refused) throw this.unexpected('PutObject', this.location, outcome.refused);
  }

  /** S3 writes only where no object is, so no other run can write in between. */
  async writeIfAbsent(state: State): Promise<boolean> {
    const outcome = await this.put(this.settings.key, serializeState(state), true);
    if (outcome.refused && statusOf(outcome.refused) === 412) return false;
    if (outcome.refused) throw this.unexpected('PutObject', this.location, outcome.refused);

    return true;
  }

  /** A lock released between the refusal and the read is tried once more. */
  async lock(info: LockInfo): Promise<void> {
    let held = await this.heldBy(info);
    if (held === 'gone') held = await this.heldBy(info);
    if (held === 'taken') return;

    throw new StateLocked(held === 'gone' ? undefined : held, `remove ${this.lockLocation}`);
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

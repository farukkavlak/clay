import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface S3Received {
  readonly method: string;
  /** The bucket and the key, as `/bucket/key`. */
  readonly path: string;
  readonly ifMatch: string | undefined;
  readonly ifNoneMatch: string | undefined;
  readonly body: string;
  /** The region the request was signed for. */
  readonly region: string | undefined;
}

interface Stored {
  readonly body: string;
  readonly etag: string;
}

/** What a request S3 took answers. */
interface Done {
  readonly status: number;
  readonly etag?: string;
  readonly body?: string;
}

/** An error S3 answers with, by its status and code. */
interface Refusal {
  readonly status: number;
  readonly code: string;
}

/** An answer of its own for the next request a test names: `hang` never answers, `lost` acts and answers nothing, `raw` is no S3 error. */
type Override = Refusal | { readonly hang: true } | { readonly lost: true } | { readonly raw: number; readonly body: string };

const read = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const etagOf = (body: string) => `"${createHash('md5').update(body, 'utf8').digest('hex')}"`;

function refuse(response: ServerResponse, { status, code }: Refusal): void {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code} from the test server</Message></Error>`);
}

function reply(response: ServerResponse, done: Done | Refusal): void {
  if ('code' in done) {
    refuse(response, done);
    return;
  }

  response.writeHead(done.status, done.etag === undefined ? {} : { etag: done.etag });
  response.end(done.body);
}

/** A hung request is never answered. */
function answerInstead(response: ServerResponse, override: Exclude<Override, { lost: true }>): void {
  if ('status' in override) refuse(response, override);
  else if ('raw' in override) {
    response.writeHead(override.raw, { 'content-type': 'text/html' });
    response.end(override.body);
  }
}

const header = (request: IncomingMessage, name: string) => request.headers[name] as string | undefined;

/**
 * An S3 server that takes the bucket in the path and keeps objects in memory. It keeps to `If-None-Match: *` on a write and to
 * `If-Match` on a delete, as AWS does.
 */
export class S3StateServer {
  readonly objects = new Map<string, Stored>();
  readonly received: S3Received[] = [];
  /** The access key every request must be signed with, where set. */
  accessKey: string | undefined;
  private overrides = new Map<string, Override[]>();
  private server: Server;

  private constructor(private readonly buckets: ReadonlySet<string>) {
    this.server = createServer(this.answer.bind(this));
  }

  static async start(...buckets: string[]): Promise<S3StateServer> {
    const server = new S3StateServer(new Set(buckets.length === 0 ? ['bucket'] : buckets));
    server.server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The text of the object at `path`, as `bucket/key`. */
  text(path: string): string | undefined {
    return this.objects.get(path)?.body;
  }

  put(path: string, body: string): void {
    this.objects.set(path, { body, etag: etagOf(body) });
  }

  /** `request` is a method and a path, as `PUT /bucket/key`; each answer is given once, in turn. */
  override(request: string, ...answers: Override[]): void {
    this.overrides.set(request, [...(this.overrides.get(request) ?? []), ...answers]);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url!, this.url);
    const method = request.method!;
    const body = await read(request);
    const region = /Credential=[^/]+\/[^/]+\/([^/]+)\//.exec(header(request, 'authorization') ?? '')?.[1];
    this.received.push({ method, path: url.pathname, ifMatch: header(request, 'if-match'), ifNoneMatch: header(request, 'if-none-match'), body, region });

    const override = this.overrides.get(`${method} ${url.pathname}`)?.shift();
    if (override !== undefined && !('lost' in override)) {
      answerInstead(response, override);
      return;
    }

    const done = this.serve(request, decodeURIComponent(url.pathname.slice(1)), body);
    if (override === undefined) reply(response, done);
    else response.destroy();
  }

  /** What a request did, or why it was refused. */
  private serve(request: IncomingMessage, path: string, body: string): Done | Refusal {
    const signedBy = /Credential=([^/]+)\//.exec(header(request, 'authorization') ?? '')?.[1];
    if (this.accessKey !== undefined && signedBy !== this.accessKey) return { status: 403, code: 'InvalidAccessKeyId' };
    if (!this.buckets.has(path.split('/')[0])) return { status: 404, code: 'NoSuchBucket' };

    const stored = this.objects.get(path);
    if (request.method === 'GET') return stored === undefined ? { status: 404, code: 'NoSuchKey' } : { status: 200, ...stored };
    if (request.method === 'PUT') return this.write(path, body, stored, header(request, 'if-none-match'));
    if (request.method === 'DELETE') return this.delete(path, stored, header(request, 'if-match'));

    return { status: 405, code: 'MethodNotAllowed' };
  }

  private write(path: string, body: string, stored: Stored | undefined, ifNoneMatch: string | undefined): Done | Refusal {
    if (ifNoneMatch === '*' && stored !== undefined) return { status: 412, code: 'PreconditionFailed' };

    this.put(path, body);
    return { status: 200, etag: this.objects.get(path)!.etag };
  }

  private delete(path: string, stored: Stored | undefined, ifMatch: string | undefined): Done | Refusal {
    if (ifMatch !== undefined) {
      if (stored === undefined) return { status: 404, code: 'NoSuchKey' };
      if (stored.etag !== ifMatch) return { status: 412, code: 'PreconditionFailed' };
    }

    this.objects.delete(path);
    return { status: 204 };
  }
}

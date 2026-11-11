import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { AddressInfo } from 'node:net';
import path from 'node:path';

export interface AzureReceived {
  readonly method: string;
  /** The container and the blob, as `/container/blob`. */
  readonly path: string;
  readonly ifMatch: string | undefined;
  readonly ifNoneMatch: string | undefined;
  readonly body: string;
  /** `key` for a request signed with a shared key, `sas` for one that carries a SAS token, `entra` for one with a bearer token. */
  readonly signed: 'key' | 'sas' | 'entra' | undefined;
  /** The bearer token the request carries. */
  readonly token: string | undefined;
}

interface Stored {
  readonly body: string;
  readonly etag: string;
}

/** What a request Azure took answers. */
interface Done {
  readonly status: number;
  readonly etag?: string;
  readonly body?: string;
}

/** An error Azure answers with, by its status and code. */
interface Refusal {
  readonly status: number;
  readonly code: string;
}

/**
 * An answer of its own for the next request a test names: `hang` never answers, `lost` acts and answers nothing, `raw` is no Azure error,
 * and `before` runs ahead of the request, which is then served as any other.
 */
type Override = Refusal | { readonly hang: true } | { readonly lost: true } | { readonly raw: number; readonly body: string } | { readonly before: () => void };

const read = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const etagOf = (body: string) => `"0x${createHash('md5').update(body, 'utf8').digest('hex').slice(0, 15).toUpperCase()}"`;

function refuse(response: ServerResponse, { status, code }: Refusal): void {
  response.writeHead(status, { 'content-type': 'application/xml', 'x-ms-error-code': code });
  response.end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code} from the test server</Message></Error>`);
}

function reply(response: ServerResponse, done: Done | Refusal): void {
  if ('code' in done) {
    refuse(response, done);
    return;
  }

  const body = done.body ?? '';
  response.writeHead(done.status, {
    ...(done.etag !== undefined && { etag: done.etag }),
    ...(done.body !== undefined && { 'content-type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }),
    'content-length': Buffer.byteLength(body, 'utf8'),
  });
  response.end(body);
}

/** A hung request is never answered. */
function answerInstead(response: ServerResponse, override: Exclude<Override, { lost: true } | { before: () => void }>): void {
  if ('status' in override) refuse(response, override);
  else if ('raw' in override) {
    response.writeHead(override.raw, { 'content-type': 'text/html' });
    response.end(override.body);
  }
}

const header = (request: IncomingMessage, name: string) => request.headers[name] as string | undefined;

const certificate = (file: string) => readFileSync(path.join(__dirname, 'tls', file));

const tokenOf = (request: IncomingMessage) => /^Bearer (.+)$/.exec(header(request, 'authorization') ?? '')?.[1];

/** A SAS token holds at least its version and its signature. */
function signedOf(request: IncomingMessage, url: URL, account: string): AzureReceived['signed'] {
  if ((header(request, 'authorization') ?? '').startsWith(`SharedKey ${account}:`)) return 'key';
  if (tokenOf(request) !== undefined) return 'entra';

  return url.searchParams.has('sv') && url.searchParams.has('sig') ? 'sas' : undefined;
}

/**
 * A Blob service for one account, at `<url>/<account>` as Azurite has it, that keeps blobs in memory. It keeps to `If-None-Match: *` on a
 * write and to `If-Match` on a delete, as Azure does, and does not check signatures.
 */
export class AzureStateServer {
  readonly blobs = new Map<string, Stored>();
  readonly received: AzureReceived[] = [];
  private overrides = new Map<string, Override[]>();
  private server: Server;

  readonly account = 'clayaccount';
  private readonly containers = new Set(['state']);

  private constructor(private readonly tls: boolean) {
    const listener = this.answer.bind(this);
    this.server = tls ? createTlsServer({ key: certificate('server.key'), cert: certificate('server.pem') }, listener) : createServer(listener);
  }

  /** Over TLS, the server shows the certificate the test CA signed for 127.0.0.1, as a bearer token is sent over https alone. */
  static async start({ tls = false }: { readonly tls?: boolean } = {}): Promise<AzureStateServer> {
    const server = new AzureStateServer(tls);
    server.server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    return server;
  }

  /** The endpoint a backend names, the account in its path. */
  get url(): string {
    return `${this.tls ? 'https' : 'http'}://127.0.0.1:${(this.server.address() as AddressInfo).port}/${this.account}`;
  }

  /** The text of the blob at `path`, as `container/blob`. */
  text(path: string): string | undefined {
    return this.blobs.get(path)?.body;
  }

  put(path: string, body: string): void {
    this.blobs.set(path, { body, etag: etagOf(body) });
  }

  /** `request` is a method and a path, as `PUT /container/blob`; each answer is given once, in turn. */
  override(request: string, ...answers: Override[]): void {
    this.overrides.set(request, [...(this.overrides.get(request) ?? []), ...answers]);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const method = request.method!;
    const body = await read(request);
    const path = url.pathname.slice(this.account.length + 1);
    const signed = signedOf(request, url, this.account);
    this.received.push({ method, path, ifMatch: header(request, 'if-match'), ifNoneMatch: header(request, 'if-none-match'), body, signed, token: tokenOf(request) });

    let override = this.overrides.get(`${method} ${path}`)?.shift();
    if (override !== undefined && 'before' in override) {
      override.before();
      override = undefined;
    }
    if (override !== undefined && !('lost' in override)) {
      answerInstead(response, override);
      return;
    }

    const done = url.pathname.startsWith(`/${this.account}/`) ? this.serve(request, decodeURIComponent(path.slice(1)), body, signed) : { status: 400, code: 'InvalidUri' };
    if (override === undefined) reply(response, done);
    else response.destroy();
  }

  /** What a request did, or why it was refused. */
  private serve(request: IncomingMessage, path: string, body: string, signed: AzureReceived['signed']): Done | Refusal {
    if (signed === undefined) return { status: 403, code: 'AuthenticationFailed' };
    if (!this.containers.has(path.split('/')[0])) return { status: 404, code: 'ContainerNotFound' };

    const stored = this.blobs.get(path);
    if (request.method === 'GET') return stored === undefined ? { status: 404, code: 'BlobNotFound' } : { status: 200, ...stored };
    if (request.method === 'PUT') return this.write(path, body, stored, header(request, 'if-none-match'));
    if (request.method === 'DELETE') return this.delete(path, stored, header(request, 'if-match'));

    return { status: 405, code: 'UnsupportedHttpVerb' };
  }

  private write(path: string, body: string, stored: Stored | undefined, ifNoneMatch: string | undefined): Done | Refusal {
    if (ifNoneMatch === '*' && stored !== undefined) return { status: 409, code: 'BlobAlreadyExists' };

    this.put(path, body);
    return { status: 201, etag: this.blobs.get(path)!.etag };
  }

  private delete(path: string, stored: Stored | undefined, ifMatch: string | undefined): Done | Refusal {
    if (stored === undefined) return { status: 404, code: 'BlobNotFound' };
    if (ifMatch !== undefined && stored.etag !== ifMatch) return { status: 412, code: 'ConditionNotMet' };

    this.blobs.delete(path);
    return { status: 202 };
  }
}

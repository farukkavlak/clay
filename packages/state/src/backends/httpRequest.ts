import { ClientRequest, IncomingMessage, request as plainRequest } from 'node:http';
import { request as tlsRequest } from 'node:https';
import { getCACertificates, TLSSocket } from 'node:tls';

export interface Outgoing {
  readonly method: string;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** What one try was answered. */
export interface Reply {
  readonly status: number;
  readonly body: string;
  /** Where a redirect points. */
  readonly location: string | null;
  readonly retryAfter: string | null;
}

/** A request the server gave no answer to, or no whole one, so whether it acted is not known. */
export class NoAnswer extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'NoAnswer';
  }
}

/** A handshake that failed fails the same on every try, and no request reached the server. */
export class HandshakeFailed extends Error {
  constructor(message: string, cause: Error) {
    super(message, { cause });
    this.name = 'HandshakeFailed';
  }
}

/** The CAs an https request trusts, asked for at its first request. */
export type Roots = () => string[];

/** Node trusts only its own CA list unless told; the system store holds the CAs a company adds. `default` keeps NODE_EXTRA_CA_CERTS. */
export function trusted(): Roots {
  let list: string[] | undefined;
  return () => (list ??= [...getCACertificates('default'), ...getCACertificates('system')]);
}

/** A certificate not trusted marks the socket; EPROTO is a server that speaks no TLS, or none Clay takes. */
function handshakeFailed(request: ClientRequest, error: Error, what: string): HandshakeFailed | undefined {
  const { socket } = request;
  if (!(socket instanceof TLSSocket)) return undefined;

  const { code } = error as NodeJS.ErrnoException;
  if (socket.authorizationError !== null || code === 'EPROTO') return new HandshakeFailed(`${what} failed the TLS handshake (${code ?? error.message})`, error);

  return undefined;
}

/** What the request or the response emits is the connection failing, or the timeout ending it. */
function noAnswer(error: unknown, what: string, signal: AbortSignal, timeout: number): NoAnswer {
  if (signal.aborted) return new NoAnswer(`${what} (timed out after ${timeout}s)`, error);
  if (!(error instanceof Error)) throw error;

  const { code, message } = error as NodeJS.ErrnoException;
  return new NoAnswer(`${what} (${code ?? message})`, error);
}

/**
 * The client is named, as a proxy may refuse a request that names none.
 * A wrong header throws here, outside the promise: that is a mistake in Clay, not the server giving no answer.
 */
function sent(url: URL, { method, body, headers }: Outgoing, signal: AbortSignal, ca: Roots): Promise<IncomingMessage> {
  const length = body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body, 'utf8')) };
  const options = { method, headers: { 'User-Agent': 'clay', ...headers, ...length }, signal };
  const request: ClientRequest = url.protocol === 'https:' ? tlsRequest(url, { ...options, ca: ca() }) : plainRequest(url, options);

  const answered = new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', resolve);
    request.on('error', (error) => reject(handshakeFailed(request, error, `${method} ${url.href}`) ?? error));
  });
  request.end(body);

  return answered;
}

/** The decoder drops a byte order mark, and puts U+FFFD for a byte that is no UTF-8. */
async function textOf(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);

  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * No redirect is followed: a POST sent on as a GET would be answered 200, which would count as written or locked.
 * The body is read apart, so one cut off after the status is not taken for no answer.
 */
export async function tryOnce(url: URL, request: Outgoing, timeout: number, ca: Roots): Promise<Reply | NoAnswer> {
  const signal = AbortSignal.timeout(timeout * 1000);
  const answered = sent(url, request, signal, ca);
  let response: IncomingMessage;
  try {
    response = await answered;
  } catch (error) {
    if (error instanceof HandshakeFailed) throw error;

    return noAnswer(error, `${request.method} ${url.href} got no answer`, signal, timeout);
  }

  // Node leaves statusCode unset only on a message a server receives.
  const { statusCode: status = 0, headers } = response;
  try {
    return { status, body: await textOf(response), location: headers.location ?? null, retryAfter: headers['retry-after'] ?? null };
  } catch (error) {
    return noAnswer(error, `${request.method} ${url.href} answered ${status}, but the body was cut off`, signal, timeout);
  }
}

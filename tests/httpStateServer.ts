import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface Received {
  readonly method: string;
  readonly path: string;
  /** The `ID` a write names its lock by. */
  readonly id: string | null;
  readonly body: string;
  /** Whether `Content-MD5` matched the body. */
  readonly digestMatches: boolean;
  readonly authorization: string | undefined;
}

interface Answer {
  status: number;
  body?: string;
  location?: string;
  retryAfter?: string;
  cut?: boolean;
  stall?: boolean;
}

/** An answer of its own for the next request a test names, as a failing server gives: `hang` never answers, `lost` acts and answers nothing. */
type Override = Answer | { hang: true } | { lost: true };

const read = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** A cut body promises more than it sends, then the connection closes; a stalled one stops sending and stays open. */
function send(response: ServerResponse, { status, body = '', location, retryAfter, cut, stall }: Answer): void {
  response.writeHead(status, { ...(location && { location }), ...(retryAfter && { 'retry-after': retryAfter }), ...((cut || stall) && { 'content-length': '100' }) });
  if (cut) response.write('{', () => response.destroy());
  else if (stall) response.write('{');
  else response.end(body);
}

const digestOf = (body: string) => createHash('md5').update(body, 'utf8').digest('base64');

/** A state server as Terraform's http backend expects one: the state at /state, its lock at /lock. A second state at /other shares the lock. */
export class HttpStateServer {
  state: string | undefined;
  other: string | undefined;
  lock: string | undefined;
  /** The `Authorization` every request must carry, where the server asks for one. */
  authorization: string | undefined;
  readonly received: Received[] = [];
  private overrides = new Map<string, Override[]>();
  private server: Server;

  private constructor() {
    this.server = createServer((request, response) => void this.answer(request, response));
  }

  static async start(): Promise<HttpStateServer> {
    const server = new HttpStateServer();
    server.server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** `request` is a method and a path, as `GET /state`; each answer is given once, in turn. */
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
    const body = await read(request);
    const method = request.method!;
    const digest = request.headers['content-md5'];
    const { authorization } = request.headers;
    this.received.push({ method, path: url.pathname, id: url.searchParams.get('ID'), body, digestMatches: digest === digestOf(body), authorization });

    const key = `${method} ${url.pathname}`;
    const override = this.overrides.get(key)?.shift();
    if (override !== undefined && 'hang' in override) return;

    const refused = this.authorization !== undefined && authorization !== this.authorization;
    const answer = override === undefined || 'lost' in override ? (refused ? { status: 401 } : this.serve(key, body)) : override;
    if (override !== undefined && 'lost' in override) response.destroy();
    else send(response, answer);
  }

  private serve(key: string, body: string): Answer {
    if (key === 'GET /state') return this.state === undefined ? { status: 404 } : { status: 200, body: this.state };
    if (key === 'POST /state') {
      this.state = body;
      return { status: 200 };
    }
    if (key === 'GET /other') return this.other === undefined ? { status: 404 } : { status: 200, body: this.other };
    if (key === 'POST /other') {
      this.other = body;
      return { status: 200 };
    }
    if (key === 'LOCK /lock') return this.take(body);
    if (key === 'UNLOCK /lock') return this.release(body);

    return { status: 405 };
  }

  private take(body: string): Answer {
    if (this.lock !== undefined) return { status: 423, body: this.lock };

    this.lock = body;
    return { status: 200 };
  }

  private release(body: string): Answer {
    if (this.lock !== body) return { status: 409, body: this.lock ?? '' };

    this.lock = undefined;
    return { status: 200 };
  }
}

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

// In-process HTTP stub for oracle self-tests and counterfactual evidence passes
// (TEMPLATE-CONTRACT.md SD-10). It binds 127.0.0.1 on an ephemeral port, never proxies to a
// real target, and keeps everything it records in memory. Unmatched requests get
// 501 {"argusStub": "unmatched"}; callers decide whether that is a failure.

export type StubQuery = Record<string, string | string[]>;

/** A response the stub serves. An object body is JSON (default content-type application/json). */
export type StubResponse = {
  status: number;
  /** Header names are lowercase. */
  headers?: Record<string, string>;
  body?: unknown;
};

/** SD-10 exchange: method and path match exactly, plus every listed query parameter. */
export type StubExchange = {
  id: string;
  request: { method: string; path: string; query?: Record<string, string> };
  response: StubResponse;
};

export type StubRequest = {
  method: string;
  path: string;
  query: StubQuery;
  headers: Record<string, string>;
  /** Parsed JSON for a JSON content type, the raw text otherwise, undefined when empty. */
  body: unknown;
};

/** A recorded request; `matched` is the exchange id, 'handler', 'handler-error', or null. */
export type StubRecord = StubRequest & { matched: string | null };

/** Tried before the exchanges; returning undefined or null falls through to them. */
export type StubHandler = (request: StubRequest) => StubResponse | null | undefined | Promise<StubResponse | null | undefined>;

const EXCHANGE_ID = /^[a-z0-9-]{1,40}$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const UNMATCHED: StubResponse = { status: 501, body: { argusStub: 'unmatched' } };

export class StubServer {
  private exchanges: StubExchange[] = [];
  private log: StubRecord[] = [];
  private readonly server: Server;
  private origin = '';

  private constructor(private readonly handler?: StubHandler) {
    this.server = createServer((req, res) => {
      void this.serve(req, res);
    });
  }

  /** Start a stub on 127.0.0.1:0. */
  static async start(options: { handler?: StubHandler } = {}): Promise<StubServer> {
    const stub = new StubServer(options.handler);
    await new Promise<void>((resolve, reject) => {
      stub.server.once('error', reject);
      stub.server.listen(0, '127.0.0.1', () => {
        stub.server.off('error', reject);
        resolve();
      });
    });
    const { port } = stub.server.address() as AddressInfo;
    stub.origin = `http://127.0.0.1:${port}`;
    return stub;
  }

  /** The stub origin, for example http://127.0.0.1:53121. */
  get url(): string {
    return this.origin;
  }

  /** Replace the exchange set and clear the request log. Invalid exchanges throw. */
  load(exchanges: StubExchange[]): void {
    if (!Array.isArray(exchanges)) throw new TypeError('stub exchanges must be an array');
    const ids = new Set<string>();
    for (const exchange of exchanges) {
      validateExchange(exchange);
      if (ids.has(exchange.id)) throw new TypeError(`duplicate stub exchange id: ${exchange.id}`);
      ids.add(exchange.id);
    }
    this.exchanges = structuredClone(exchanges);
    this.log = [];
  }

  /**
   * Resolve a request against the loaded exchanges without the network, for page.route.
   * The request is recorded like a served one; null means unmatched (answer it with 501).
   */
  resolve(request: { method: string; path: string; query?: StubQuery }): StubResponse | null {
    const target = splitPath(request.path);
    const query = { ...target.query, ...(request.query ?? {}) };
    const record: StubRequest = { method: request.method.toUpperCase(), path: target.path, query, headers: {}, body: undefined };
    const exchange = this.match(record);
    this.log.push({ ...record, matched: exchange?.id ?? null });
    return exchange ? structuredClone(exchange.response) : null;
  }

  /** Every request received or resolved since the last load, in order. */
  requests(): StubRecord[] {
    return structuredClone(this.log);
  }

  /** The requests that got the 501 unmatched response. */
  unmatched(): StubRecord[] {
    return this.requests().filter((record) => record.matched === null);
  }

  /** Close the listener and every open keep-alive connection. */
  async stop(): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
    // Playwright request contexts keep sockets alive; close() alone would wait for them.
    this.server.closeAllConnections();
    await closed;
  }

  private match(request: StubRequest): StubExchange | undefined {
    return this.exchanges.find((exchange) => exchange.request.method === request.method
      && exchange.request.path === request.path
      && Object.entries(exchange.request.query ?? {}).every(([name, value]) => request.query[name] === String(value)));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let record: StubRecord | undefined;
    try {
      const raw = await readBody(req);
      if (raw === null) {
        write(res, { status: 413, body: { argusStub: 'body-too-large' } });
        return;
      }
      const target = parseTarget(req.url ?? '/');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const request: StubRequest = {
        method: (req.method ?? 'GET').toUpperCase(),
        path: target.pathname,
        query: toQuery(target.searchParams),
        headers,
        body: parseBody(raw, headers['content-type']),
      };
      record = { ...request, matched: null };
      this.log.push(record);
      if (this.handler) {
        let handled: StubResponse | null | undefined;
        try {
          handled = await this.handler(structuredClone(request));
        } catch {
          record.matched = 'handler-error';
          write(res, { status: 500, body: { argusStub: 'handler-error' } });
          return;
        }
        if (handled) {
          record.matched = 'handler';
          write(res, handled);
          return;
        }
      }
      const exchange = this.match(request);
      record.matched = exchange?.id ?? null;
      write(res, exchange ? exchange.response : UNMATCHED);
    } catch {
      if (record) record.matched = 'handler-error';
      if (!res.headersSent) write(res, { status: 500, body: { argusStub: 'stub-error' } });
      else res.destroy();
    }
  }
}

function validateExchange(exchange: StubExchange): void {
  const id = exchange?.id;
  if (typeof id !== 'string' || !EXCHANGE_ID.test(id)) throw new TypeError(`invalid stub exchange id: ${String(id)}`);
  const { request, response } = exchange;
  if (!request || typeof request.method !== 'string' || !/^[A-Z]+$/.test(request.method)) {
    throw new TypeError(`stub exchange ${id}: request.method must be an uppercase HTTP method`);
  }
  if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.includes('?')) {
    throw new TypeError(`stub exchange ${id}: request.path must start with "/" and carry no query string`);
  }
  if (request.query !== undefined && (typeof request.query !== 'object' || request.query === null || Array.isArray(request.query))) {
    throw new TypeError(`stub exchange ${id}: request.query must be a map`);
  }
  validateResponse(response, `stub exchange ${id}`);
}

function validateResponse(response: StubResponse, label: string): void {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new TypeError(`${label}: response.status must be an integer HTTP status`);
  }
  for (const name of Object.keys(response.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw new TypeError(`${label}: header names must be lowercase tokens: ${name}`);
  }
}

function write(res: ServerResponse, response: StubResponse): void {
  validateResponse(response, 'stub response');
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  let payload: Buffer | undefined;
  const { body } = response;
  if (body === undefined) {
    payload = undefined;
  } else if (typeof body === 'string') {
    payload = Buffer.from(body, 'utf8');
    headers['content-type'] ??= 'text/plain; charset=utf-8';
  } else if (body instanceof Uint8Array) {
    payload = Buffer.from(body);
    headers['content-type'] ??= 'application/octet-stream';
  } else {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    headers['content-type'] ??= 'application/json';
  }
  // 204 and 304 carry no content by definition; Node drops a body written for them.
  const bodyless = response.status === 204 || response.status === 304;
  if (payload && !bodyless) headers['content-length'] = String(payload.length);
  res.writeHead(response.status, headers);
  res.end(bodyless ? undefined : payload);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  if (!contentType || !/[/+]json\b/i.test(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toQuery(params: URLSearchParams): StubQuery {
  const query: StubQuery = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    query[name] = values.length === 1 ? values[0] : values;
  }
  return query;
}

function splitPath(path: string): { path: string; query: StubQuery } {
  if (!path.includes('?')) return { path, query: {} };
  const target = parseTarget(path);
  return { path: target.pathname, query: toQuery(target.searchParams) };
}

// An origin-form target ('/a?b') is appended to the stub origin, so '//x/y' stays a path
// instead of becoming a host; an absolute-form target keeps only its path and query.
function parseTarget(target: string): URL {
  return target.startsWith('/') ? new URL(`http://127.0.0.1${target}`) : new URL(target, 'http://127.0.0.1');
}

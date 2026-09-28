// Minimal HTTP helpers shared by the corpus application and its modules.
// Only node: builtins; the corpus must run without installed dependencies.

// Public test accounts. Requests identify their actor with the x-actor header.
export const ACCOUNTS = Object.freeze(['alice', 'bob', 'carol']);

// A request-level failure the application dispatcher turns into an HTTP response.
export class RequestError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const hasContentType = headers => Object.keys(headers).some(name => name.toLowerCase() === 'content-type');

// JSON by default. A string body is sent verbatim when the caller supplies its own content-type.
export function send(res, status, body, headers = {}) {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (typeof body === 'string' && hasContentType(headers)) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, html) {
  send(res, status, html, { 'content-type': 'text/html; charset=utf-8' });
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  send(res, status, text, { 'content-type': contentType });
}

export function methodNotAllowed(res, allowed) {
  send(res, 405, { error: 'method-not-allowed' }, { allow: allowed.join(', ') });
}

const payloadTooLarge = () => new RequestError(413, { error: 'payload-too-large' }, { connection: 'close' });

// Resolves the UTF-8 request body. Rejects with a 413 RequestError once the body exceeds
// `limit` bytes; the remainder is drained, not buffered, so the response can still be sent.
export function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(payloadTooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(payloadTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

// An empty body is an empty object. Malformed JSON throws; the dispatcher answers 400 invalid-json.
export function parseJson(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestError(400, { error: 'invalid-json' });
  }
}

// Reads a JSON request body that must be a plain object.
export async function readJsonObject(req, limit) {
  const value = parseJson(await readBody(req, limit));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(422, { error: 'json-object-required' });
  return value;
}

// The acting account from x-actor, or null when the header is missing or names no known account.
export function actorOf(req) {
  const actor = req.headers['x-actor'];
  return typeof actor === 'string' && ACCOUNTS.includes(actor) ? actor : null;
}

// Probe-side client: one HTTP exchange with the parsed JSON body when the response carries one.
export async function call(baseUrl, method, path, { actor, json, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (actor) requestHeaders['x-actor'] = actor;
  let body;
  if (json !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(new URL(path, baseUrl), { method, headers: requestHeaders, body });
  const text = await response.text();
  let parsed;
  if ((response.headers.get('content-type') ?? '').startsWith('application/json') && text) parsed = JSON.parse(text);
  return { status: response.status, headers: response.headers, text, json: parsed };
}

// Path segments after a module base path: segmentsAfter('/api/orders/claim', '/api/orders') -> ['claim'].
export function segmentsAfter(pathname, base) {
  if (pathname === base || pathname === `${base}/`) return [];
  if (!pathname.startsWith(`${base}/`)) return null;
  return pathname.slice(base.length + 1).split('/').filter(Boolean).map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

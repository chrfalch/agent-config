import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ledgers, Reply } from './ledgers.js';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const MAX_BODY_BYTES = 64 * 1024;

/** 32 random bytes; a new one each time the server starts. */
export const newKey = (): string => randomBytes(32).toString('base64url');

// Hashed first, because timingSafeEqual needs equal lengths and a length check would leak the key's length.
const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

type Input = { query: URLSearchParams; body: Record<string, unknown> };
type Route = { method: 'GET' | 'POST'; run(input: Input): Promise<Reply> };

const badRequest = (error: string): Reply => ({ status: 400, body: { error } });

function forTask(id: unknown, then: (id: string) => Promise<Reply>): Promise<Reply> {
  return typeof id === 'string' && id !== '' ? then(id) : Promise.resolve(badRequest('Give the id of a task, as /api/ledgers lists it.'));
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function routes(ledgers: Ledgers): Record<string, Route> {
  return {
    '/api/health': { method: 'GET', run: async () => ({ status: 200, body: { ok: true, pid: process.pid } }) },
    '/api/ledgers': {
      method: 'GET',
      run: async ({ query }) => ledgers.list({ repo: query.get('repo') ?? '', status: query.get('status') ?? '', q: query.get('q') ?? '' }),
    },
    '/api/ledger': { method: 'GET', run: async ({ query }) => forTask(query.get('id'), ledgers.detail) },
    '/api/rescan': { method: 'POST', run: () => ledgers.rescan() },
    '/api/retire/preview': { method: 'POST', run: async ({ body }) => forTask(body.id, ledgers.previewRetire) },
    '/api/retire': {
      method: 'POST',
      run: async ({ body }) => {
        if (body.force !== undefined && typeof body.force !== 'boolean') return badRequest('force is true or false.');
        return forTask(body.id, id => ledgers.retire(id, stringOf(body.token), body.force === true));
      },
    },
    '/api/park': { method: 'POST', run: async ({ body }) => forTask(body.id, id => ledgers.park(id, stringOf(body.reason))) },
    '/api/unpark': { method: 'POST', run: async ({ body }) => forTask(body.id, ledgers.unpark) },
  };
}

const COMMON_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function send(res: http.ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function sendPage(res: http.ServerResponse, method: string): void {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  res.writeHead(200, { ...COMMON_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
  res.end(method === 'HEAD' ? undefined : PAGE.replaceAll('{{nonce}}', nonce));
}

const isJson = (contentType: string | undefined): boolean => /^application\/json\s*(;|$)/i.test(contentType ?? '');

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null;
  } catch {
    return null;
  }
}

/** Listens on 127.0.0.1 only. Every /api request must carry `key` in X-Ledger-Key. */
export function startServer({ ledgers, key, port }: { ledgers: Ledgers; key: string; port: number }): Promise<http.Server> {
  const table = routes(ledgers);
  const expected = digest(key);
  const isKey = (given: string | string[] | undefined): boolean => typeof given === 'string' && timingSafeEqual(digest(given), expected);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A page on another site can point its own host name at 127.0.0.1; only these two names are this server.
    const { port: bound } = server.address() as AddressInfo;
    if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(req.headers.host ?? '')) {
      send(res, 403, { error: 'This server answers only to 127.0.0.1 and localhost on its own port.' });
      return;
    }
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (pathname === '/') {
      if (method === 'GET' || method === 'HEAD') sendPage(res, method);
      else send(res, 405, { error: 'The page takes GET only.' }, { allow: 'GET, HEAD' });
      return;
    }
    if (!pathname.startsWith('/api/')) {
      send(res, 404, { error: 'Not found.' });
      return;
    }
    if (!isKey(req.headers['x-ledger-key'])) {
      send(res, 401, { error: 'Missing or wrong X-Ledger-Key. Open the address that /ledger:dashboard printed.' });
      return;
    }
    const route = table[pathname];
    if (route === undefined) {
      send(res, 404, { error: `No API route ${pathname}.` });
      return;
    }
    if (method !== route.method) {
      send(res, 405, { error: `${pathname} takes ${route.method} only.` }, { allow: route.method });
      return;
    }
    let body: Record<string, unknown> = {};
    if (route.method === 'POST') {
      if (!isJson(req.headers['content-type'])) {
        send(res, 415, { error: 'Send the body as application/json.' });
        return;
      }
      const text = await readBody(req);
      if (text === null) {
        send(res, 413, { error: 'The body is too large.' });
        return;
      }
      const parsed = parseObject(text);
      if (parsed === null) {
        send(res, 400, { error: 'The body is not a JSON object.' });
        return;
      }
      body = parsed;
    }
    const reply = await route.run({ query: searchParams, body });
    send(res, reply.status, reply.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${new Date().toISOString()} ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) send(res, 500, { error: message });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

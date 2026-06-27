import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { BotManager } from '../bot/botManager.js';
import type {
  AppSettings,
  DiscordRuntimeInput,
  LauncherState,
  OperationKind,
  OperationStartRequest,
  SaveProfileInput
} from '../../shared/types.js';

export interface LocalWebServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface LocalWebServerOptions {
  manager: BotManager;
  staticDir: string;
  openUserData: () => Promise<void>;
  preferredPort?: number;
  host?: string;
  devRendererUrl?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const PORT_SCAN_LIMIT = 12;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export async function startLocalWebServer(options: LocalWebServerOptions): Promise<LocalWebServer> {
  const host = options.host ?? DEFAULT_HOST;
  const preferredPort = normalizePort(options.preferredPort ?? (Number(process.env.AFK_LAUNCHER_WEB_PORT) || DEFAULT_PORT));
  const ports = preferredPort === 0 ? [0] : Array.from({ length: PORT_SCAN_LIMIT }, (_, index) => preferredPort + index);
  let lastError: unknown = null;

  for (const port of ports) {
    const localServer = createLocalHttpServer(options);
    try {
      await listen(localServer.server, host, port);
      const address = localServer.server.address() as AddressInfo;
      const actualPort = address.port;
      return {
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => closeServer(localServer.server)
      };
    } catch (error) {
      lastError = error;
      localServer.dispose();
      if (!isAddressInUse(error) || preferredPort === 0) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Local web dashboard port is unavailable.');
}

function createLocalHttpServer(options: LocalWebServerOptions): { server: Server; dispose: () => void } {
  const clients = new Set<ServerResponse>();
  const publishState = (state: LauncherState) => {
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) {
      client.write(frame);
    }
  };

  options.manager.on('state', publishState);

  const server = http.createServer((request, response) => {
    void handleRequest(options, clients, request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(request, response, 500, { error: formatError(error) });
    });
  });

  const dispose = () => {
    options.manager.off('state', publishState);
    for (const client of clients) {
      client.end();
    }
    clients.clear();
  };

  server.once('close', dispose);
  return { server, dispose };
}

async function handleRequest(
  options: LocalWebServerOptions,
  clients: Set<ServerResponse>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!isLocalHostHeader(request.headers.host)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  if (!isAllowedOrigin(request.headers.origin)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  if (request.method === 'OPTIONS') {
    setCorsHeaders(request, response);
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST',
      'Access-Control-Max-Age': '600'
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApiRequest(options, clients, request, response, url);
    return;
  }

  await serveStatic(options, request, response, url);
}

async function handleApiRequest(
  options: LocalWebServerOptions,
  clients: Set<ServerResponse>,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/api/state') {
    sendJson(request, response, 200, options.manager.getState());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    setCorsHeaders(request, response);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    });
    response.write(`event: state\ndata: ${JSON.stringify(options.manager.getState())}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (request.method === 'POST' && url.pathname === '/api/profiles') {
    const body = await readJsonBody<SaveProfileInput>(request);
    sendJson(request, response, 200, await options.manager.saveProfile(body));
    return;
  }

  if (request.method === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'profiles') {
    sendJson(request, response, 200, await options.manager.deleteProfile(parts[2]));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'profiles' && parts[3] === 'select') {
    sendJson(request, response, 200, await options.manager.selectProfile(parts[2]));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/bots/start-all') {
    sendJson(request, response, 200, await options.manager.startAll());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/bots/stop-all') {
    sendJson(request, response, 200, await options.manager.stopAll());
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'connect') {
    sendJson(request, response, 200, await options.manager.connect(parts[2]));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'disconnect') {
    sendJson(request, response, 200, await options.manager.disconnect(parts[2]));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'chat') {
    const body = await readJsonBody<{ message?: string }>(request);
    sendJson(request, response, 200, await options.manager.sendChat(parts[2], body.message ?? ''));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'quick-script') {
    const body = await readJsonBody<{ command?: string }>(request);
    sendJson(request, response, 200, await options.manager.runQuickScript(parts[2], body.command ?? ''));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'complete') {
    const body = await readJsonBody<{ partial?: string }>(request);
    sendJson(request, response, 200, { completions: await options.manager.completeChat(parts[2], body.partial ?? '') });
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'discord') {
    const body = await readJsonBody<DiscordRuntimeInput>(request);
    sendJson(request, response, 200, await options.manager.configureDiscord(parts[2], body));
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'bots' && parts[3] === 'operations') {
    const body = await readJsonBody<OperationStartRequest>(request);
    sendJson(request, response, 200, await options.manager.startOperation(parts[2], body));
    return;
  }

  if (
    request.method === 'DELETE' &&
    parts.length === 5 &&
    parts[0] === 'api' &&
    parts[1] === 'bots' &&
    parts[3] === 'operations'
  ) {
    sendJson(request, response, 200, await options.manager.stopOperation(parts[2], parts[4] as OperationKind));
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/settings') {
    const body = await readJsonBody<Partial<AppSettings>>(request);
    sendJson(request, response, 200, await options.manager.updateSettings(body));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/open-user-data') {
    await options.openUserData();
    sendJson(request, response, 200, { ok: true });
    return;
  }

  sendJson(request, response, 404, { error: 'Not found' });
}

async function serveStatic(options: LocalWebServerOptions, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed');
    return;
  }

  if (options.devRendererUrl) {
    response.writeHead(302, { Location: options.devRendererUrl });
    response.end();
    return;
  }

  const relativePath = safeRelativePath(url.pathname);
  if (!relativePath) {
    sendText(response, 400, 'Bad request');
    return;
  }

  const requestedPath = path.join(options.staticDir, relativePath);
  const filePath = await findStaticFile(options.staticDir, requestedPath);
  if (!filePath) {
    sendText(response, 404, 'Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    ...securityHeaders()
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function findStaticFile(staticDir: string, requestedPath: string): Promise<string | null> {
  const normalizedStaticDir = path.resolve(staticDir);
  const normalizedRequestedPath = path.resolve(requestedPath);
  if (!normalizedRequestedPath.startsWith(`${normalizedStaticDir}${path.sep}`) && normalizedRequestedPath !== normalizedStaticDir) {
    return null;
  }

  try {
    const info = await stat(normalizedRequestedPath);
    if (info.isFile()) return normalizedRequestedPath;
  } catch {
    // Fall through to the SPA index fallback.
  }

  const indexPath = path.join(normalizedStaticDir, 'index.html');
  try {
    const indexInfo = await stat(indexPath);
    return indexInfo.isFile() ? indexPath : null;
  } catch {
    return null;
  }
}

function safeRelativePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    return relativePath.includes('\0') ? null : relativePath;
  } catch {
    return null;
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, data: unknown): void {
  setCorsHeaders(request, response);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders()
  });
  response.end(JSON.stringify(data));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    ...securityHeaders()
  });
  response.end(body);
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' http://127.0.0.1:* http://localhost:*",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
}

function isAllowedOrigin(origin: string | string[] | undefined): boolean {
  if (!origin) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  try {
    const url = new URL(value);
    return isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return true;
  return isLocalHostname(hostnameFromHostHeader(host));
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith('[')) {
    return host.slice(1, host.indexOf(']'));
  }
  return host.split(':')[0] ?? host;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizePort(port: number): number {
  if (!Number.isFinite(port)) return DEFAULT_PORT;
  return Math.max(0, Math.min(65535, Math.trunc(port)));
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

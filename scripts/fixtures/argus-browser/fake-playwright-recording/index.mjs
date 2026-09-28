// Test-only recording stand-in for the Playwright package. It lets the provisioning probe
// and the managed hunt driver run end to end without a real browser: navigation performs a
// real HTTP GET against the configured base URL, and every call is appended to the file
// named by FAKE_PLAYWRIGHT_LOG (one "<event> <detail>" line each) so a smoke can prove which
// module was imported and what the driver did with it. It implements every BrowserContext
// and Page member hunt-driver.mjs touches, including locator(...).ariaSnapshot(), context
// 'page' events, context-level init scripts, clock, routes, and offline mode. Like
// Playwright 1.57+, pages have no `accessibility` member.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// A 1x1 transparent PNG, so callers that check the PNG signature accept screenshots.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function record(event, detail = '') {
  const log = process.env.FAKE_PLAYWRIGHT_LOG;
  if (log) appendFileSync(log, `${`${event} ${detail}`.trim()}\n`);
}

record('import', MODULE_DIR);

function textBetween(html, tag) {
  const match = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(html);
  return match ? match[1].trim() : '';
}

async function httpRequest(method, url, options = {}) {
  const init = { method, headers: { ...(options.headers ?? {}) } };
  if (options.data !== undefined) {
    init.body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
    init.headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(url, init);
  const body = await response.text();
  return {
    ok: () => response.ok,
    status: () => response.status,
    url: () => response.url,
    headers: () => Object.fromEntries(response.headers),
    body: async () => Buffer.from(body),
    text: async () => body,
    json: async () => JSON.parse(body),
    request: () => ({ method: () => method }),
  };
}

function createLocator(page, selector) {
  const locator = {
    first: () => locator,
    async waitFor(options = {}) { record('locator.waitFor', `${selector} state=${options.state ?? 'visible'}`); },
    async click() { record('locator.click', selector); },
    async fill(value) { record('locator.fill', `${selector} length=${String(value).length}`); },
    async hover() { record('locator.hover', selector); },
    async selectOption(value) { record('locator.selectOption', selector); return [String(value)]; },
    async setInputFiles() { record('locator.setInputFiles', selector); },
    async ariaSnapshot() {
      record('locator.ariaSnapshot', selector);
      const heading = textBetween(page.content, 'h1');
      return heading ? `- heading "${heading}" [level=1]` : '- document';
    },
  };
  return locator;
}

function createPage(context) {
  const listeners = new Map();
  const emit = (event, value) => {
    for (const entry of [...(listeners.get(event) ?? [])]) {
      if (entry.once) listeners.get(event).delete(entry);
      entry.handler(value);
    }
  };
  const subscribe = (event, handler, once) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add({ handler, once });
  };
  const page = {
    content: '',
    currentUrl: 'about:blank',
    on(event, handler) { record('page.on', event); subscribe(event, handler, false); return page; },
    once(event, handler) { record('page.once', event); subscribe(event, handler, true); return page; },
    async goto(route, options = {}) {
      const url = new URL(route, context.baseURL ?? undefined).href;
      const response = await httpRequest('GET', url);
      page.content = await response.text();
      page.currentUrl = response.url();
      record('page.goto', `${url} status=${response.status()} waitUntil=${options.waitUntil ?? 'load'}`);
      emit('response', response);
      return response;
    },
    url: () => page.currentUrl,
    async waitForTimeout(milliseconds) { record('page.waitForTimeout', String(milliseconds)); },
    locator: (selector) => createLocator(page, selector),
    async setContent(html) { page.content = String(html); record('page.setContent', `length=${page.content.length}`); },
    async screenshot(options = {}) {
      if (options.path) {
        mkdirSync(dirname(options.path), { recursive: true });
        writeFileSync(options.path, PNG);
      }
      record('page.screenshot', options.path ?? '(buffer)');
      return PNG;
    },
    async evaluate() { record('page.evaluate'); return null; },
    async addInitScript() { record('page.addInitScript'); },
    async setViewportSize(size) { record('page.setViewportSize', `${size.width}x${size.height}`); },
    async goBack() { record('page.goBack'); return null; },
    keyboard: { async press(key) { record('page.keyboard.press', key); } },
    clock: { async install(options = {}) { record('page.clock.install', new Date(options.time ?? 0).toISOString()); } },
    async close() { record('page.close'); },
  };
  return page;
}

function createContext(userDataDir, options) {
  const listeners = new Map();
  const pages = [];
  const context = {
    baseURL: options.baseURL ?? null,
    pages: () => [...pages],
    on(event, handler) {
      record('context.on', event);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return context;
    },
    async newPage() {
      const page = createPage(context);
      pages.push(page);
      record('context.newPage');
      for (const handler of [...(listeners.get('page') ?? [])]) handler(page);
      return page;
    },
    async addInitScript() { record('context.addInitScript'); },
    clock: {
      async install(clockOptions = {}) { record('context.clock.install', new Date(clockOptions.time ?? 0).toISOString()); },
      async fastForward(ticks) { record('context.clock.fastForward', String(ticks)); },
    },
    async route(pattern) { record('context.route', String(pattern)); },
    async unroute(pattern) { record('context.unroute', String(pattern)); },
    async setOffline(offline) { record('context.setOffline', String(offline)); },
    request: {
      get: (url, requestOptions) => httpRequest('GET', new URL(url, options.baseURL ?? undefined).href, requestOptions),
      post: (url, requestOptions) => httpRequest('POST', new URL(url, options.baseURL ?? undefined).href, requestOptions),
    },
    tracing: {
      async start() { record('context.tracing.start'); },
      async stop(stopOptions = {}) {
        if (stopOptions.path) {
          mkdirSync(dirname(stopOptions.path), { recursive: true });
          writeFileSync(stopOptions.path, '');
        }
        record('context.tracing.stop', stopOptions.path ?? '');
      },
    },
    async close() { record('context.close', userDataDir); },
  };
  pages.push(createPage(context));
  return context;
}

export const chromium = {
  executablePath: () => '/argus-fixture/chromium/recording-headless-shell',
  async launchPersistentContext(userDataDir, options = {}) {
    mkdirSync(userDataDir, { recursive: true });
    record('launch', `${userDataDir} headless=${options.headless !== false}`);
    return createContext(userDataDir, options);
  },
};

export default { chromium };

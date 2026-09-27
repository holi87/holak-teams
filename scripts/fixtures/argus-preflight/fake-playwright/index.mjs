// Test-only stand-in for the Playwright package: the preflight browser-runtime probe
// imports it, launches a persistent context, sets page content, and closes it. Every
// member is a no-op so the probe exercises resolution without a real browser.
const page = {
  async setContent() {},
  async screenshot() { return Buffer.alloc(0); },
  async goto() { return null; },
  async close() {},
};

const context = {
  pages() { return [page]; },
  async newPage() { return page; },
  async close() {},
};

export const chromium = {
  executablePath() { return '/argus-fixture/chromium/headless-shell'; },
  async launchPersistentContext() { return context; },
};

export default { chromium };

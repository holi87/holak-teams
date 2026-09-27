// Test-only Playwright stand-in whose browser launch fails, as it does on a host where
// the package is installed but its Chromium build was never downloaded.
export const chromium = {
  executablePath() { return '/argus-fixture/chromium/missing-headless-shell'; },
  async launchPersistentContext() {
    throw new Error('fixture: browser executable missing');
  },
};

export default { chromium };

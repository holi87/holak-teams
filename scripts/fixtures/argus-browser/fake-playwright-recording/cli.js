// Test-only stand-in for Playwright's cli.js. Browser provisioning runs it with a
// restricted environment (HOME, PATH, and proxy settings only), so it records the call in
// $HOME/fake-playwright-cli.log, including whether PLAYWRIGHT_BROWSERS_PATH leaked through.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.HOME) {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? 'unset';
  appendFileSync(join(process.env.HOME, 'fake-playwright-cli.log'), `cli ${args.join(' ')} PLAYWRIGHT_BROWSERS_PATH=${browsersPath}\n`);
}
process.exit(args[0] === 'install' && args[1] === 'chromium' && args.length === 2 ? 0 : 1);

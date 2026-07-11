import { test as setup } from '@playwright/test';
import { LoginPage } from '../../src/pages/login.page';

// Canonical Playwright UI-auth: log in ONCE here, persist storageState,
// every test in the `ui` project starts already authenticated (see playwright.config.ts).
const USER_STATE = `${process.env.ARGUS_AUTH_DIRECTORY ?? '.auth'}/user.json`;

setup('authenticate as user via UI', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.loginAs('user');
  await page.waitForURL(/dashboard|home|\/$/); // <-- adapt the success signal
  await page.context().storageState({ path: USER_STATE });
});

import { test, expect } from '../../src/fixtures/fixtures';
import { visualBounds } from '../../src/oracles';

// ADAPT-ME: example specs for the funded, risk-derived UI lane. Every assertion is exact:
// the full URL and the heading text the requirement names, never a pattern that several
// pages would match. The `ui` project starts AUTHENTICATED via storageState
// (tests/setup/auth.setup.ts), so there is no per-test login. Use page objects for
// interactions; keep assertions in the spec.

// ADAPT-ME: routes and texts from the requirement or Kalchas's recon, cited in the strategy.
const UI_SPEC = {
  homePath: '/dashboard',
  homeHeading: 'Dashboard',
  primaryAction: 'New order',
  loginHeading: 'Sign in',
  badCredentialsMessage: 'Invalid email or password.',
} as const;

test('@ui authenticated user lands on the dashboard', async ({ page }) => {
  await page.goto('/'); // storageState already carries the session
  await expect(page).toHaveURL(UI_SPEC.homePath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(UI_SPEC.homeHeading);
});

test('@ui the primary action fits a 375 px phone viewport', async ({ page }) => {
  await page.goto(UI_SPEC.homePath);
  // Off-screen, overflowing, or covered at 375 px is RED; the viewport is restored afterwards.
  await visualBounds(page.getByRole('button', { name: UI_SPEC.primaryAction, exact: true }));
});

test.describe('@ui anonymous', () => {
  // A fresh, unauthenticated state for these tests only: no cookies and no stored tokens.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('@ui login rejects bad credentials and stays on the login page', async ({ loginPage, page }) => {
    await loginPage.goto();
    await loginPage.usernameInput.fill('nobody@example.com');
    await loginPage.passwordInput.fill('wrong-password');
    await loginPage.submitButton.click();
    await expect(page.getByRole('alert')).toHaveText(UI_SPEC.badCredentialsMessage);
    await expect(page).toHaveURL(loginPage.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(UI_SPEC.loginHeading);
  });
});

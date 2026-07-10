import { test, expect } from '../../src/fixtures/fixtures';

// ADAPT-ME: critical-path UI smoke only. Keep UI tests few; push coverage to the API layer.
// The `ui` project starts AUTHENTICATED via storageState (tests/setup/auth.setup.ts) —
// no per-test login. Use page objects for interactions; keep assertions in the spec.
test('@ui authenticated user reaches the app', async ({ page }) => {
  await page.goto('/'); // storageState already carries the session
  await expect(page).toHaveURL(/dashboard|home|\/$/); // <-- adapt the success signal
});

test('@ui login rejects bad credentials', async ({ loginPage, page }) => {
  // Fresh, unauthenticated state for this test only:
  await page.context().clearCookies();
  await loginPage.goto();
  await loginPage.usernameInput.fill('nobody@example.com');
  await loginPage.passwordInput.fill('wrong-password');
  await loginPage.submitButton.click();
  await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible(); // <-- adapt
});
